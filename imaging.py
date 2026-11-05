from __future__ import annotations

from functools import lru_cache
from io import BytesIO
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageCms, ImageFilter, ImageOps
import tifffile

from color_tools import apply_color_tools
from detail_tools import apply_detail_tools

PREVIEW_EDGE = 1440
SRGB_PROFILE = ImageCms.createProfile("sRGB")
SRGB_ICC = ImageCms.ImageCmsProfile(SRGB_PROFILE).tobytes()
LUMA = np.array((0.2126, 0.7152, 0.0722), dtype=np.float32)
MASK_ADJUSTMENTS = {
    "exposure": (-3, 3),
    "highlights": (-100, 100),
    "shadows": (-100, 100),
    "temperature": (-100, 100),
    "saturation": (-100, 100),
}
MAX_MASKS = 100


def _number(settings, key, low, high, default=0.0):
    value = settings.get(key, default)
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError(f"{key} 的数值无效")
    return min(high, max(low, value))


def _unit_value(value, label):
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError(f"{label} 必须是 0 到 1 之间的有限数值")
    return float(value)


def validate_masks(masks):
    """Validate and normalize a photo's editable local-mask settings."""
    if not isinstance(masks, list) or len(masks) > MAX_MASKS:
        raise ValueError(f"蒙版列表必须是数组，且每张照片不能超过 {MAX_MASKS} 个")

    result = []
    seen_ids = set()
    for index, mask in enumerate(masks):
        if not isinstance(mask, dict):
            raise ValueError(f"第 {index + 1} 个蒙版格式无效")
        mask_id = mask.get("id")
        if not isinstance(mask_id, str) or not mask_id.strip() or len(mask_id) > 80:
            raise ValueError(f"第 {index + 1} 个蒙版标识无效")
        if mask_id in seen_ids:
            raise ValueError("蒙版标识不能重复")
        seen_ids.add(mask_id)

        name = mask.get("name", f"蒙版 {index + 1}")
        if not isinstance(name, str) or not name.strip() or len(name) > 80:
            raise ValueError(f"第 {index + 1} 个蒙版名称无效")
        kind = mask.get("type")
        if kind not in ("linear", "radial"):
            raise ValueError(f"蒙版类型无效：{name}")
        enabled = mask.get("enabled", True)
        invert = mask.get("invert", False)
        if type(enabled) is not bool or type(invert) is not bool:
            raise ValueError(f"蒙版开关格式无效：{name}")

        geometry = mask.get("geometry")
        if not isinstance(geometry, dict):
            raise ValueError(f"蒙版几何参数无效：{name}")
        if kind == "linear":
            start, end = geometry.get("start"), geometry.get("end")
            if not isinstance(start, dict) or not isinstance(end, dict):
                raise ValueError(f"线性蒙版端点无效：{name}")
            normalized_geometry = {
                "start": {axis: _unit_value(start.get(axis), f"{name} 起点") for axis in ("x", "y")},
                "end": {axis: _unit_value(end.get(axis), f"{name} 终点") for axis in ("x", "y")},
            }
            dx = normalized_geometry["end"]["x"] - normalized_geometry["start"]["x"]
            dy = normalized_geometry["end"]["y"] - normalized_geometry["start"]["y"]
            if dx * dx + dy * dy < 1e-8:
                raise ValueError(f"线性蒙版两端不能重合：{name}")
        else:
            center, radius = geometry.get("center"), geometry.get("radius")
            if not isinstance(center, dict) or not isinstance(radius, dict):
                raise ValueError(f"径向蒙版中心或半径无效：{name}")
            normalized_geometry = {
                "center": {axis: _unit_value(center.get(axis), f"{name} 中心") for axis in ("x", "y")},
                "radius": {axis: _unit_value(radius.get(axis), f"{name} 半径") for axis in ("x", "y")},
            }
            if min(normalized_geometry["radius"].values()) < 1e-4:
                raise ValueError(f"径向蒙版半径不能为零或过小：{name}")

        feather = _unit_value(mask.get("feather", 0), f"{name} 羽化")
        adjustments = mask.get("adjustments", {})
        if not isinstance(adjustments, dict) or set(adjustments) - set(MASK_ADJUSTMENTS):
            raise ValueError(f"蒙版局部参数无效：{name}")
        normalized_adjustments = {
            key: _number(adjustments, key, low, high)
            for key, (low, high) in MASK_ADJUSTMENTS.items()
        }
        result.append({
            "id": mask_id,
            "name": name.strip(),
            "type": kind,
            "enabled": enabled,
            "geometry": normalized_geometry,
            "feather": feather,
            "invert": invert,
            "adjustments": normalized_adjustments,
        })
    return result


def _mask_weight(mask, width, height, row_start=0, row_end=None):
    """Return the mask opacity for a bounded image row range."""
    row_end = height if row_end is None else row_end
    x = (np.arange(width, dtype=np.float32) + 0.5) / width
    y = (np.arange(row_start, row_end, dtype=np.float32) + 0.5) / height
    geometry = mask["geometry"]

    if mask["type"] == "linear":
        start, end = geometry["start"], geometry["end"]
        dx, dy = end["x"] - start["x"], end["y"] - start["y"]
        distance = dx * dx + dy * dy
        t = ((x[None, :] - start["x"]) * dx +
             (y[:, None] - start["y"]) * dy) / distance
        t = np.clip(t, 0, 1)
        weight = 1 - t * t * (3 - 2 * t)
    else:
        center, radius = geometry["center"], geometry["radius"]
        delta_x = x[None, :] * width - center["x"] * width
        delta_y = y[:, None] * height - center["y"] * height
        radius_x, radius_y = radius["x"] * width, radius["y"] * height
        rho = np.sqrt((delta_x / radius_x) ** 2 + (delta_y / radius_y) ** 2)
        if mask["feather"] == 0:
            weight = (rho <= 1).astype(np.float32)
        else:
            radial_distance = np.sqrt(delta_x * delta_x + delta_y * delta_y)
            fallback_radius = np.float32(min(radius_x, radius_y))
            boundary_radius = np.divide(
                radial_distance, rho,
                out=np.full_like(rho, fallback_radius, dtype=np.float32),
                where=rho > 1e-6,
            )
            feather_pixels = mask["feather"] * min(width, height)
            depth = np.clip((1 - rho) * boundary_radius / feather_pixels, 0, 1)
            weight = depth * depth * (3 - 2 * depth)

    if mask["invert"]:
        weight = 1 - weight
    return np.asarray(weight, dtype=np.float32)


def _apply_masks(rgb, masks):
    for mask in masks:
        if not mask["enabled"] or not any(mask["adjustments"].values()):
            continue
        height, width = rgb.shape[:2]
        for row_start in range(0, height, 256):
            row_end = min(height, row_start + 256)
            weight = _mask_weight(mask, width, height, row_start, row_end)
            if not np.any(weight):
                continue
            pixels = rgb[row_start:row_end]
            adjusted = pixels.copy()
            _adjust(adjusted, mask["adjustments"])
            pixels += (adjusted - pixels) * weight[:, :, None]
            np.clip(pixels, 0, 1, out=pixels)


ASPECT_PRESETS = frozenset(("free", "original", "1:1", "4:5", "3:2", "16:9"))
DEFAULT_COMPOSITION = {"crop": None, "aspect": "free", "rotation": 0, "straighten": 0}


def validate_composition(value):
    """Validate a non-destructive crop/rotation/straighten state."""
    if value is None:
        value = {}
    if not isinstance(value, dict):
        raise ValueError("构图参数格式无效")
    crop = value.get("crop")
    if crop is None:
        normalized_crop = None
    else:
        if not isinstance(crop, dict):
            raise ValueError("裁剪框格式无效")
        x = _unit_value(crop.get("x"), "裁剪框左侧")
        y = _unit_value(crop.get("y"), "裁剪框上侧")
        width = _unit_value(crop.get("width"), "裁剪框宽度")
        height = _unit_value(crop.get("height"), "裁剪框高度")
        if width <= 0 or height <= 0 or x + width > 1 + 1e-9 or y + height > 1 + 1e-9:
            raise ValueError("裁剪框必须位于图像范围内且面积大于零")
        normalized_crop = {"x": x, "y": y, "width": width, "height": height}

    aspect = value.get("aspect", "free")
    if not isinstance(aspect, str) or aspect not in ASPECT_PRESETS:
        raise ValueError("裁剪比例无效")
    rotation = value.get("rotation", 0)
    if type(rotation) is not int or rotation not in (0, 90, 180, 270):
        raise ValueError("旋转角度必须是 0、90、180 或 270 度")
    straighten = value.get("straighten", 0)
    if type(straighten) not in (int, float) or not math.isfinite(straighten) or not -15 <= straighten <= 15:
        raise ValueError("拉直角度必须在 -15 到 15 度之间")
    return {
        "crop": normalized_crop,
        "aspect": aspect,
        "rotation": rotation,
        "straighten": float(straighten),
    }


def _largest_inscribed_size(width, height, clockwise_degrees):
    """Largest centered crop with the input aspect ratio after rotation."""
    angle = math.radians(abs(clockwise_degrees))
    cosine, sine = math.cos(angle), math.sin(angle)
    aspect = width / height
    maximum_height = min(
        width / (aspect * cosine + sine),
        height / (aspect * sine + cosine),
    )
    # Keep a two-pixel safety margin for bicubic interpolation at every edge.
    output_height = max(1, math.floor(maximum_height) - 4)
    output_width = max(1, min(width, round(output_height * aspect)))
    return output_width, output_height


def _rotate_float(rgb, clockwise_degrees):
    rotated = np.empty_like(rgb)
    for channel in range(3):
        plane = Image.fromarray(np.asarray(rgb[:, :, channel], dtype=np.float32)).rotate(
            -clockwise_degrees,
            resample=Image.Resampling.BICUBIC,
            expand=False,
            fillcolor=0.0,
        )
        rotated[:, :, channel] = np.asarray(plane, dtype=np.float32)
    return rotated


def _resize_float(rgb, width, height):
    if rgb.shape[1] == width and rgb.shape[0] == height:
        return rgb
    resized = np.empty((height, width, 3), dtype=np.float32)
    for channel in range(3):
        plane = Image.fromarray(np.asarray(rgb[:, :, channel], dtype=np.float32))
        resized[:, :, channel] = np.asarray(
            plane.resize((width, height), Image.Resampling.LANCZOS),
            dtype=np.float32,
        )
    return resized


def _apply_composition(rgb, composition):
    channel_min = rgb.min(axis=(0, 1), keepdims=True)
    channel_max = rgb.max(axis=(0, 1), keepdims=True)
    rotation = composition["rotation"]
    if rotation:
        rgb = np.rot90(rgb, k=-(rotation // 90)).copy()

    crop = composition["crop"]
    if crop is not None:
        height, width = rgb.shape[:2]
        left = min(width - 1, max(0, math.floor(crop["x"] * width)))
        top = min(height - 1, max(0, math.floor(crop["y"] * height)))
        right = min(width, max(left + 1, math.ceil((crop["x"] + crop["width"]) * width)))
        bottom = min(height, max(top + 1, math.ceil((crop["y"] + crop["height"]) * height)))
        rgb = rgb[top:bottom, left:right].copy()

    angle = composition["straighten"]
    if abs(angle) > 1e-6:
        height, width = rgb.shape[:2]
        inner_width, inner_height = _largest_inscribed_size(width, height, angle)
        rgb = _rotate_float(rgb, angle)
        left = (width - inner_width) // 2
        top = (height - inner_height) // 2
        rgb = rgb[top:top + inner_height, left:left + inner_width]
        rgb = _resize_float(rgb, width, height)

    return np.clip(rgb, channel_min, channel_max, out=rgb)


@lru_cache(maxsize=4)
def _read_cube(path, modified, byte_count):
    size = 0
    rows = 0
    lower = np.zeros(3, dtype=np.float32)
    upper = np.ones(3, dtype=np.float32)
    bounds = set()
    try:
        with path.open(encoding="utf-8-sig") as source:
            for line in source:
                tokens = line.partition("#")[0].split()
                if not tokens:
                    continue
                command = tokens[0].upper()
                if command == "TITLE":
                    continue
                if command == "LUT_3D_SIZE" and len(tokens) == 2 and not size:
                    size = int(tokens[1])
                    if not 2 <= size <= 128:
                        raise ValueError("LUT 网格应在 2 到 128 之间")
                    samples = np.empty((size ** 3, 3), dtype=np.float32)
                    continue
                if command in {"DOMAIN_MIN", "DOMAIN_MAX"} and len(tokens) == 4 and not rows:
                    if command in bounds:
                        raise ValueError("LUT 输入范围重复")
                    bounds.add(command)
                    values = np.array([float(value) for value in tokens[1:]], dtype=np.float32)
                    if command == "DOMAIN_MIN":
                        lower = values
                    else:
                        upper = values
                    continue
                if command == "LUT_3D_INPUT_RANGE" and len(tokens) == 3 and not rows and not bounds:
                    lower.fill(float(tokens[1]))
                    upper.fill(float(tokens[2]))
                    bounds.update(("DOMAIN_MIN", "DOMAIN_MAX"))
                    continue
                if command in {"LUT_1D_SIZE", "LUT_1D_INPUT_RANGE"}:
                    raise ValueError("请选择独立的 3D .cube，当前不支持一维或混合 LUT")
                if not size or len(tokens) != 3 or rows >= len(samples):
                    raise ValueError("LUT 的采样表尺寸或行格式有误")
                samples[rows] = [float(value) for value in tokens]
                rows += 1
    except UnicodeError as error:
        raise ValueError("LUT 应为 UTF-8 或 ASCII 文本") from error

    if not size or rows != size ** 3:
        raise ValueError("LUT 采样行数与网格尺寸不符")
    span = upper.astype(np.float64) - lower
    if not np.isfinite(samples).all() or not np.isfinite(span).all() or np.any(span < 1e-12):
        raise ValueError("LUT 含有无效的数值或输入范围")
    return samples.reshape((size, size, size, 3)), lower, upper


def _cube(path):
    info = path.stat()
    if info.st_size > 64 * 1024 ** 2:
        raise ValueError("LUT 文件超过 64 MB")
    return _read_cube(path, info.st_mtime_ns, info.st_size)


def validate_lut(path: Path) -> None:
    try:
        _cube(path)
    except (ValueError, OverflowError) as error:
        raise ValueError(f"无法读取 .cube：{error}") from error


def _apply_table(rgb, table, lower, upper, strength):
    size = table.shape[0]
    input_pixels = rgb.reshape((-1, 3))
    for start in range(0, len(input_pixels), 120_000):
        pixels = input_pixels[start:start + 120_000]
        points = np.clip((pixels - lower) / (upper - lower), 0, 1) * (size - 1)
        low = points.astype(np.intp)
        high = np.minimum(low + 1, size - 1)
        frac = (points - low).astype(np.float32)
        result = np.zeros_like(pixels)
        # .cube stores red fastest, so the table axes are blue, green, red.
        for corner in range(8):
            red = bool(corner & 1)
            green = bool(corner & 2)
            blue = bool(corner & 4)
            weight = (frac[:, 0] if red else 1 - frac[:, 0])
            weight = weight * (frac[:, 1] if green else 1 - frac[:, 1])
            weight *= frac[:, 2] if blue else 1 - frac[:, 2]
            result += table[
                (high if blue else low)[:, 2],
                (high if green else low)[:, 1],
                (high if red else low)[:, 0],
            ] * weight[:, None]
        pixels += (result - pixels) * strength


@lru_cache(maxsize=4)
def _icc_table(profile):
    source = ImageCms.ImageCmsProfile(BytesIO(profile))
    if ImageCms.getProfileDescription(source).strip().casefold() in {
        "srgb built-in", "srgb iec61966-2.1", "srgb iec61966-2.1 black scaled",
    }:
        return None
    # Sample the 8-bit CMS path, then interpolate the source's 16-bit values.
    blue, green, red = np.indices((33, 33, 33))
    samples = np.stack((red, green, blue), axis=-1).reshape((33 * 33, 33, 3))
    pattern = Image.fromarray(np.rint(samples * (255 / 32)).astype(np.uint8))
    converted = ImageCms.profileToProfile(pattern, source, SRGB_PROFILE, outputMode="RGB")
    return (np.asarray(converted, dtype=np.float32) / 255).reshape((33, 33, 33, 3))


def _to_srgb(image, profile):
    if profile and profile != SRGB_ICC:
        try:
            source = ImageCms.ImageCmsProfile(BytesIO(profile))
            return ImageCms.profileToProfile(image, source, SRGB_PROFILE, outputMode="RGB")
        except (OSError, TypeError, ValueError, ImageCms.PyCMSError):
            pass
    return image.convert("RGB")


def _orient(rgb, orientation):
    match orientation:
        case 2:
            return rgb[:, ::-1]
        case 3:
            return rgb[::-1, ::-1]
        case 4:
            return rgb[::-1]
        case 5:
            return rgb.transpose((1, 0, 2))
        case 6:
            return np.rot90(rgb, -1)
        case 7:
            return rgb.transpose((1, 0, 2))[::-1, ::-1]
        case 8:
            return np.rot90(rgb, 1)
        case _:
            return rgb


def _target_size(width, height, edge):
    scale = min(1, edge / max(width, height))
    return max(1, round(width * scale)), max(1, round(height * scale))


def _read_deep_tiff(path, edge):
    with tifffile.TiffFile(path) as container:
        page = container.pages[0]
        if page.photometric not in (0, 1, 2):
            return None
        pixels = page.asarray()
        if page.axes in ("SYX", "CYX"):
            pixels = np.moveaxis(pixels, 0, -1)
        if pixels.ndim == 2:
            pixels = np.repeat(pixels[:, :, None], 3, axis=2)
        if pixels.ndim != 3 or pixels.shape[2] not in (3, 4):
            return None
        if pixels.dtype.kind not in ("u", "f"):
            return None
        orientation = page.tags.get(274)
        profile_tag = page.tags.get(34675)
        profile = bytes(profile_tag.value) if profile_tag else None
        rgb = _orient(pixels[:, :, :3], orientation.value if orientation else 1)
        target_size = _target_size(rgb.shape[1], rgb.shape[0], edge) if edge else None
        divisor = (2 ** page.bitspersample - 1) if rgb.dtype.kind == "u" else 1
        if target_size and target_size != (rgb.shape[1], rgb.shape[0]):
            channels = (
                Image.fromarray(np.asarray(rgb[:, :, index], dtype=np.float32)).resize(
                    target_size, Image.Resampling.LANCZOS
                )
                for index in range(3)
            )
            rgb = np.stack([np.asarray(channel) for channel in channels], axis=-1)
        else:
            rgb = np.array(rgb, dtype=np.float32, order="C")
        rgb /= divisor
        if page.photometric == 0:
            np.subtract(1, rgb, out=rgb)
        if profile and profile != SRGB_ICC:
            try:
                table = _icc_table(profile)
                if table is not None:
                    _apply_table(rgb, table, 0, 1, 1)
            except (OSError, TypeError, ValueError, ImageCms.PyCMSError):
                pass
        return np.clip(rgb, 0, 1, out=rgb)


def _decode(path, edge=None):
    with Image.open(path) as source:
        profile = source.info.get("icc_profile")
        if source.format == "TIFF" and max(source.tag_v2.get(258, (8,))) > 8:
            try:
                rgb = _read_deep_tiff(path, edge)
            except (OSError, ValueError, NotImplementedError):
                rgb = None
            if rgb is not None:
                return rgb
            # shortcut: obscure compressed TIFF layouts use Pillow's RGB conversion.
        image = ImageOps.exif_transpose(source)
        if edge:
            image.thumbnail((edge, edge), Image.Resampling.LANCZOS)
        if image.mode in ("RGBA", "LA") or "transparency" in image.info:
            overlay = image.convert("RGBA")
            alpha = overlay.getchannel("A")
            image = Image.composite(_to_srgb(overlay.convert("RGB"), profile),
                                    Image.new("RGB", overlay.size, "white"), alpha)
        else:
            image = _to_srgb(image, profile)
        return np.asarray(image, dtype=np.float32) / 255


def estimate_white_balance(rgb, x, y):
    """Estimate absolute temperature/tint slider values from normalized source coordinates."""
    x = _unit_value(x, "取样点横坐标")
    y = _unit_value(y, "取样点纵坐标")
    if not isinstance(rgb, np.ndarray) or rgb.ndim != 3 or rgb.shape[2] < 3:
        raise ValueError("无法读取白平衡取样图像")
    height, width = rgb.shape[:2]
    if height < 1 or width < 1:
        raise ValueError("白平衡取样图像为空")

    center_x = round(x * (width - 1))
    center_y = round(y * (height - 1))
    left, right = max(0, center_x - 4), min(width, center_x + 5)
    top, bottom = max(0, center_y - 4), min(height, center_y + 5)
    sample = np.median(rgb[top:bottom, left:right, :3], axis=(0, 1)).astype(np.float64)
    if not np.isfinite(sample).all():
        raise ValueError("取样区域过亮、过暗或颜色过饱和，请点击未剪切的中性灰或白色区域。")
    brightest = float(sample.max())
    darkest = float(sample.min())
    if (darkest <= 5 / 255 or brightest >= 250 / 255 or
            (brightest - darkest) / max(brightest, 1e-9) > 0.55):
        raise ValueError("取样区域过亮、过暗或颜色过饱和，请点击未剪切的中性灰或白色区域。")

    linear = np.where(sample <= 0.04045, sample / 12.92,
                      ((sample + 0.055) / 1.055) ** 2.4)
    red_blue_ratio = max(float(linear[0]), 1e-9) / max(float(linear[2]), 1e-9)
    temperature = float(np.clip(-math.log2(red_blue_ratio) / 0.8, -1, 1))
    gains = np.array((2 ** (temperature * 0.35), 1,
                      2 ** (-temperature * 0.45)), dtype=np.float64)
    balanced_linear = linear * gains
    balanced = np.where(balanced_linear <= 0.0031308,
                        12.92 * balanced_linear,
                        1.055 * balanced_linear ** (1 / 2.4) - 0.055)

    luma_red, luma_green, luma_blue = (0.2126, 0.7152, 0.0722)
    magenta_green = -((luma_red + luma_blue) / luma_green)
    luminance = float(balanced @ np.array((luma_red, luma_green, luma_blue)))
    tint_scale = 0.58 * luminance * (1 - luminance)
    tint = (balanced[1] - (balanced[0] + balanced[2]) / 2) / max(
        tint_scale * (1 - magenta_green), 1e-9
    )
    return {
        "temperature": int(round(temperature * 100)),
        "tint": int(round(float(np.clip(tint, -1, 1)) * 100)),
    }


def sample_white_balance(path: Path, x, y):
    return estimate_white_balance(_decode(path, PREVIEW_EDGE), x, y)


@lru_cache(maxsize=8)
def _decode_preview(path, modified, byte_count):
    return _decode(path, PREVIEW_EDGE)


def _blur(plane, radius):
    samples = np.rint(np.clip(plane, 0, 1) * 255).astype(np.uint8)
    return np.asarray(Image.fromarray(samples).filter(ImageFilter.GaussianBlur(radius)),
                      dtype=np.float32) / 255


def _adjust(rgb, settings):
    exposure = _number(settings, "exposure", -3, 3)
    temperature = _number(settings, "temperature", -100, 100) / 100
    shadows = _number(settings, "shadows", -100, 100) / 100
    highlights = _number(settings, "highlights", -100, 100) / 100
    contrast = _number(settings, "contrast", -100, 100) / 100
    saturation = _number(settings, "saturation", -100, 100) / 100
    clarity = _number(settings, "clarity", -100, 100) / 100

    if exposure or temperature:
        gains = np.array([2 ** (exposure + temperature * 0.35), 2 ** exposure,
                          2 ** (exposure - temperature * 0.45)], dtype=np.float32)
        for start in range(0, len(rgb), 256):
            pixels = rgb[start:start + 256]
            linear = np.where(pixels <= .04045, pixels / 12.92, ((pixels + .055) / 1.055) ** 2.4)
            linear *= gains
            pixels[:] = np.where(linear <= .0031308, 12.92 * linear,
                                 1.055 * linear ** (1 / 2.4) - .055)
    if shadows or highlights or contrast or saturation:
        for start in range(0, len(rgb), 256):
            pixels = rgb[start:start + 256]
            lum = np.clip(pixels @ LUMA, 0, 1)
            shift = shadows * .42 * lum * (1 - lum) ** 2
            shift += highlights * .42 * lum ** 2 * (1 - lum)
            pixels += shift[:, :, None]
            pixels += contrast * .52 * (pixels - .5)
            if saturation:
                lum = pixels @ LUMA
                pixels += saturation * (pixels - lum[:, :, None])
    if clarity:
        lum = np.clip(rgb @ LUMA, 0, 1)
        detail = lum - _blur(lum, max(1.5, min(rgb.shape[:2]) / 160))
        rgb += (detail * clarity * .85)[:, :, None]
    np.clip(rgb, 0, 1, out=rgb)


def _retouch(rgb, settings):
    blemishes = _number(settings, "blemishes", 0, 100) / 100
    smoothing = _number(settings, "smoothing", 0, 100) / 100
    skin_tone = _number(settings, "skinTone", 0, 100) / 100
    texture = _number(settings, "texture", 0, 100) / 100
    region = settings.get("skinRegion")
    if not region or not any((blemishes, smoothing, skin_tone, texture)):
        return
    if not isinstance(region, dict):
        raise ValueError("皮肤区域格式无效")
    height, width = rgb.shape[:2]
    x = _number(region, "x", 0, 1)
    y = _number(region, "y", 0, 1)
    right = min(width, math.ceil((x + _number(region, "width", 0, 1)) * width))
    bottom = min(height, math.ceil((y + _number(region, "height", 0, 1)) * height))
    left, top = math.floor(x * width), math.floor(y * height)
    if right - left < 4 or bottom - top < 4:
        return
    patch = rgb[top:bottom, left:right]
    yy = np.linspace(-1, 1, bottom - top, dtype=np.float32)[:, None]
    xx = np.linspace(-1, 1, right - left, dtype=np.float32)[None, :]
    mask = np.clip((1 - yy * yy - xx * xx) * 3, 0, 1)
    mask = (mask * mask * (3 - 2 * mask))[:, :, None]
    radius = max(1, min(patch.shape[:2]) / 65)
    softened = np.stack([_blur(patch[:, :, index], radius) for index in range(3)], axis=-1)
    details = patch - softened
    luminance_detail = details @ LUMA
    fine_weight = np.clip(1 - np.abs(luminance_detail) * 9, 0, 1)[:, :, None]
    change = -details * (smoothing * .75) * fine_weight
    if skin_tone:
        chroma = details - luminance_detail[:, :, None]
        change -= chroma * skin_tone * .82
    if texture:
        change += (luminance_detail * texture * .5)[:, :, None] * fine_weight
    if blemishes:
        redness = details[:, :, 0] - details[:, :, 1]
        marks = np.clip((redness - .015) * 12, 0, 1)
        change -= details * (marks * blemishes * .95)[:, :, None]
    patch += change * mask
    np.clip(patch, 0, 1, out=patch)


def render(path: Path, settings: dict, lut: Path | None, format: str, preview: bool = False) -> bytes:
    composition = validate_composition(settings.get("composition"))
    masks = validate_masks(settings.get("masks", []))
    if preview:
        info = path.stat()
        rgb = _decode_preview(path, info.st_mtime_ns, info.st_size).copy()
    else:
        rgb = _decode(path)
    _adjust(rgb, settings)
    apply_detail_tools(rgb, settings, preview)
    _retouch(rgb, settings)
    apply_color_tools(rgb, settings)
    _apply_masks(rgb, masks)
    strength = _number(settings, "lutStrength", 0, 100, 100) / 100
    if lut and strength:
        table, lower, upper = _cube(lut)
        _apply_table(rgb, table, lower, upper, strength)
        np.clip(rgb, 0, 1, out=rgb)

    finishing = {
        "exposure": _number(settings, "postExposure", -3, 3),
        "temperature": _number(settings, "postTemperature", -100, 100),
        "contrast": _number(settings, "postContrast", -100, 100),
    }
    if any(finishing.values()):
        _adjust(rgb, finishing)
    rgb = _apply_composition(rgb, composition)

    target = BytesIO()
    if format in ("tif", "tiff"):
        tifffile.imwrite(target, np.rint(rgb * 65535).astype(np.uint16),
                         photometric="rgb", compression="deflate", iccprofile=SRGB_ICC,
                         metadata=None)
    elif format in ("jpeg", "jpg", "png"):
        output = Image.fromarray(np.rint(rgb * 255).astype(np.uint8))
        if format == "png":
            output.save(target, "PNG", icc_profile=SRGB_ICC)
        else:
            output.save(target, "JPEG", quality=88 if preview else 96, subsampling=0,
                        icc_profile=SRGB_ICC)
    else:
        raise ValueError("不支持该导出格式")
    return target.getvalue()
