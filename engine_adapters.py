"""Optional local tools for RAW development and the Patchy handoff."""

from importlib.util import find_spec
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parent


def _executable(setting: str, name: str, *relative_paths: str) -> Path | None:
    configured = os.environ.get(setting)
    if configured:
        candidate = Path(configured.strip('"')).expanduser().resolve()
        if candidate.is_file():
            return candidate

    for location in relative_paths:
        candidate = ROOT / "Tools" / location
        if candidate.is_file():
            return candidate

    found = shutil.which(name)
    if found:
        return Path(found).resolve()

    for variable in ("ProgramW6432", "ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
        directory = os.environ.get(variable)
        if not directory:
            continue
        base = Path(directory)
        if variable == "LOCALAPPDATA":
            base /= "Programs"
        for location in relative_paths:
            candidate = base / location
            if candidate.is_file():
                return candidate
    return None


def _patchy() -> Path | None:
    return _executable("PHOTO_WORKBENCH_PATCHY", "patchy.exe", "Patchy/patchy.exe", "Patchy/Patchy/patchy.exe")


def _darktable() -> Path | None:
    return _executable(
        "PHOTO_WORKBENCH_DARKTABLE", "darktable-cli.exe",
        "darktable/bin/darktable-cli.exe", "darktable/darktable-cli.exe",
    )


def _has_rawpy() -> bool:
    return all(find_spec(module) is not None for module in ("rawpy", "tifffile", "PIL"))


def capabilities() -> dict:
    raw_engine = "darktable-cli" if _darktable() else "rawpy" if _has_rawpy() else None
    return {"patchy": _patchy() is not None, "raw": raw_engine is not None, "raw_engine": raw_engine}


def open_in_patchy(path: Path) -> None:
    image = path.resolve(strict=True)
    if not image.is_file() or image.suffix.lower() not in {".tif", ".tiff"}:
        raise ValueError("交接文件必须是已导出的 TIFF 图像。")

    patchy = _patchy()
    if patchy is None:
        raise RuntimeError(
            "未找到 Patchy。请把官方 Windows 便携版完整解压到 Tools\\Patchy，"
            "或将 PHOTO_WORKBENCH_PATCHY 设置为 patchy.exe 的完整路径后重启。"
        )
    try:
        subprocess.Popen(
            [str(patchy), str(image)], cwd=patchy.parent,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except OSError as exc:
        raise RuntimeError(f"无法启动 Patchy（{patchy}）。请确认便携版已完整解压。{exc}") from exc


def _develop_with_darktable(executable: Path, source: Path, output: Path) -> None:
    result = subprocess.run(
        [
            str(executable), str(source), str(output),
            "--icc-type", "SRGB", "--apply-custom-presets", "false", "--core",
            "--configdir", str(output.parent), "--cachedir", str(output.parent),
            "--conf", "plugins/imageio/format/tiff/bpp=16",
            "--conf", "plugins/imageio/format/tiff/compress=0",
        ],
        cwd=executable.parent, capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=180, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode or not output.is_file() or output.stat().st_size <= 8:
        detail = (result.stderr.strip() or result.stdout.strip())[-800:]
        raise RuntimeError(detail or f"未生成 TIFF，退出码 {result.returncode}。")


def _develop_with_rawpy(source: Path, output: Path) -> None:
    import rawpy
    import tifffile
    from PIL import ImageCms

    # The file object keeps non-ASCII Windows paths out of LibRaw's narrow-path API.
    with source.open("rb") as original, rawpy.imread(original) as image:
        pixels = image.postprocess(
            use_camera_wb=True, no_auto_bright=True, output_bps=16,
            output_color=rawpy.ColorSpace.sRGB, gamma=(2.4, 12.92),
        )
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    tifffile.imwrite(output, pixels, photometric="rgb", iccprofile=profile)


def decode_raw(path: Path, destination: Path) -> None:
    source = path.resolve(strict=True)
    destination = destination.resolve()
    if not source.is_file() or destination == source or destination.suffix.lower() not in {".tif", ".tiff"}:
        raise ValueError("RAW 输入须为文件，显影输出须为单独的 TIFF 文件。")

    darktable = _darktable()
    has_rawpy = _has_rawpy()
    if darktable is None and not has_rawpy:
        raise RuntimeError(
            "当前没有 RAW 解码后端。可先把 RAW 显影为 TIFF 再导入，"
            "也可设置 PHOTO_WORKBENCH_DARKTABLE 指向 darktable-cli.exe。"
        )

    # Stage beside the destination so a failed conversion cannot replace a previous result.
    with tempfile.TemporaryDirectory(prefix="raw-", dir=destination.parent) as workspace:
        output = Path(workspace) / "image.tif"
        failures = []
        if darktable is not None:
            try:
                _develop_with_darktable(darktable, source, output)
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
                failures.append(f"darktable-cli：{exc}")
        if (darktable is None or failures) and has_rawpy:
            try:
                _develop_with_rawpy(source, output)
            except Exception as exc:
                failures.append(f"LibRaw：{exc}")
            else:
                failures.clear()
        if failures:
            raise RuntimeError("RAW 显影失败。请核对相机格式，或先转换成 TIFF。\n" + "\n".join(failures))
        os.replace(output, destination)