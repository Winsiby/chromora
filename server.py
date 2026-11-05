from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import sys
import tempfile
import threading
import time
import traceback
import webbrowser
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "vendor"))

from PIL import Image, ImageCms
from engine_adapters import capabilities, decode_raw, open_in_patchy
from imaging import (render, sample_white_balance, validate_composition,
                     validate_lut, validate_masks)

DATA = ROOT / "数据"
PHOTOS = DATA / "原片"
DECODED = DATA / "RAW显影"
THUMBS = DATA / "缩略图"
LUTS = DATA / "风格"
PROJECTS = DATA / "工程"
PREFERENCES = DATA / "工作台设置.json"
OUTPUT = ROOT / "导出"
HANDOFF = DATA / "精修交接"
RAW = frozenset(".3fr .arw .cr2 .cr3 .dng .erf .iiq .kdc .mef .mrw .nef .nrw .orf .pef .raf .raw .rw2 .srw .x3f".split())
RASTER = frozenset(".jpg .jpeg .png .tif .tiff".split())
PHOTO_ID = re.compile(r"[a-f0-9]{64}\.[a-z0-9]{2,5}")
LUT_ID = re.compile(r"[a-f0-9]{64}")
FORMATS = {"jpeg": ".jpg", "tiff": ".tif", "psd": ".psd"}
STATIC = {"/": ("index.html", "text/html; charset=utf-8"),
          "/app.css": ("app.css", "text/css; charset=utf-8"),
          "/app.js": ("app.js", "text/javascript; charset=utf-8"),
          "/history.js": ("history.js", "text/javascript; charset=utf-8")}
IMAGE_JOBS = threading.Semaphore(1)


def atomic_write(path: Path, data: bytes) -> None:
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".writing-", delete=False) as stream:
        temporary = Path(stream.name)
    try:
        temporary.write_bytes(data)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def clean_filename(name: str) -> str:
    name = re.split(r"[/\\]", name)[-1]
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")[:120] or "照片"


def project_path(name: str) -> Path:
    if not isinstance(name, str) or not name.strip() or len(name) > 80:
        raise ValueError("请输入 1 到 80 个字符的工程名称。")
    return PROJECTS / (hashlib.sha256(name.strip().encode()).hexdigest() + ".json")


def original_path(photo_id: str) -> Path:
    if not isinstance(photo_id, str) or not PHOTO_ID.fullmatch(photo_id):
        raise ValueError("照片标识无效。")
    path = PHOTOS / photo_id
    if not path.is_file():
        raise FileNotFoundError("找不到工程里的照片，请重新导入原片。")
    return path


def validate_project_state(state: dict, *, check_originals: bool = False) -> None:
    photos = state.get("photos")
    if not isinstance(photos, list):
        raise ValueError("工程中的照片列表无效。")
    for index, photo in enumerate(photos):
        if not isinstance(photo, dict):
            raise ValueError(f"工程中的第 {index + 1} 张照片数据无效。")
        if check_originals:
            original_path(photo.get("id"))
        rating = photo.get("rating", 0)
        if isinstance(rating, bool) or not isinstance(rating, int) or not 0 <= rating <= 5:
            raise ValueError(f"工程中的第 {index + 1} 张照片星级必须是 0 到 5 的整数。")
        flag = photo.get("flag")
        if flag is not None and flag not in ("pick", "reject"):
            raise ValueError(f"工程中的第 {index + 1} 张照片旗标无效。")
        settings = photo.get("settings", {})
        if not isinstance(settings, dict):
            raise ValueError(f"工程中的第 {index + 1} 张照片调整参数无效。")
        validate_composition(settings.get("composition"))
        validate_masks(settings.get("masks", []))


def render_source(photo_id: str) -> Path:
    path = original_path(photo_id)
    if path.suffix not in RAW:
        return path
    decoded = DECODED / (path.name + ".tif")
    if not decoded.is_file():
        with tempfile.TemporaryDirectory(dir=DECODED) as temporary:
            developed = Path(temporary) / "developed.tif"
            decode_raw(path, developed)
            os.replace(developed, decoded)
    return decoded


def thumb(photo_id: str) -> bytes:
    original_path(photo_id)
    path = THUMBS / (photo_id + ".jpg")
    if not path.is_file():
        image = Image.open(io.BytesIO(render(render_source(photo_id), {}, None, "jpeg", preview=True)))
        image.thumbnail((240, 160), Image.Resampling.LANCZOS)
        small = io.BytesIO()
        image.save(small, "JPEG", quality=82)
        atomic_write(path, small.getvalue())
    return path.read_bytes()


def lut_path(lut_id: str | None) -> Path | None:
    if not lut_id:
        return None
    if not isinstance(lut_id, str) or not LUT_ID.fullmatch(lut_id):
        raise ValueError("风格标识无效。")
    path = LUTS / (lut_id + ".cube")
    if not path.is_file():
        raise FileNotFoundError("找不到该 LUT，请重新导入风格。")
    return path


def make_psd(source: Path, settings: dict, lut: Path | None) -> bytes:
    from psd_tools import PSDImage
    from psd_tools.constants import Resource
    from psd_tools.psd.image_resources import ImageResource

    original_settings = {"composition": settings.get("composition")}
    with Image.open(io.BytesIO(render(source, original_settings, None, "png"))) as image:
        original = image.convert("RGB")
    with Image.open(io.BytesIO(render(source, settings, lut, "png"))) as image:
        edited = image.convert("RGB")
    document = PSDImage.new("RGB", original.size)
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    document.image_resources[Resource.ICC_PROFILE] = ImageResource(key=Resource.ICC_PROFILE, data=profile)
    document.create_pixel_layer(original, name="Original")
    document.create_pixel_layer(edited, name="Edited")
    output = io.BytesIO()
    document.save(output)
    return output.getvalue()


class WorkbenchHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        if self.server.debug:
            super().log_message(format, *args)

    def respond(self, data: bytes, media: str, status=HTTPStatus.OK, *, cached=False):
        self.send_response(status)
        self.send_header("Content-Type", media)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "private, max-age=86400" if cached else "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Referrer-Policy", "no-referrer")
        if media.startswith("text/html"):
            self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers()
        self.wfile.write(data)

    def json(self, value, status=HTTPStatus.OK):
        self.respond(json.dumps(value, ensure_ascii=False, allow_nan=False).encode(), "application/json; charset=utf-8", status)

    def body(self, maximum: int) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if not 0 < length <= maximum:
            self.close_connection = True
            raise ValueError(f"文件或数据超出 {maximum // (1024 * 1024)} MB 限制，或内容为空。")
        data = self.rfile.read(length)
        if len(data) != length:
            raise ValueError("文件传输中断，请重新导入。")
        return data

    def json_body(self) -> dict:
        def invalid_constant(_):
            raise ValueError("参数包含无效数值。")

        try:
            value = json.loads(self.body(2 * 1024 * 1024), parse_constant=invalid_constant)
        except (json.JSONDecodeError, UnicodeError) as error:
            raise ValueError("请求数据格式有误。") from error
        if not isinstance(value, dict):
            raise ValueError("请求数据格式有误。")
        return value

    def dispatch(self, method: str) -> None:
        authority = f"127.0.0.1:{self.server.server_port}"
        if (self.headers.get("Host") != authority or
                self.headers.get("Origin") not in (None, f"http://{authority}") or
                self.headers.get("Sec-Fetch-Site") in ("cross-site", "same-site")):
            self.close_connection = True
            self.json({"error": "工作台只接受本机页面发起的请求。"}, HTTPStatus.FORBIDDEN)
            return
        url = urlsplit(self.path)
        query = {key: values[0] for key, values in parse_qs(url.query).items()}
        try:
            if method == "GET":
                self.get(url.path, query)
            else:
                self.post(url.path, query)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            return
        except FileNotFoundError as error:
            self.json({"error": str(error)}, HTTPStatus.NOT_FOUND)
        except (ValueError, TypeError, OSError, RuntimeError, Image.DecompressionBombError) as error:
            if self.server.debug:
                traceback.print_exc()
            self.json({"error": str(error) or "操作失败，请重试。"}, HTTPStatus.BAD_REQUEST)
        except Exception:
            traceback.print_exc()
            self.json({"error": "处理失败，请查看工作台启动窗口里的错误信息。"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def get(self, route: str, query: dict):
        if route in STATIC:
            filename, media = STATIC[route]
            self.respond((ROOT / filename).read_bytes(), media)
        elif route == "/api/capabilities":
            self.json({**capabilities(), "portrait": "local"})
        elif route == "/api/thumb":
            with IMAGE_JOBS:
                content = thumb(query.get("id", ""))
            self.respond(content, "image/jpeg", cached=True)
        elif route == "/api/preferences":
            self.json(json.loads(PREFERENCES.read_text(encoding="utf-8")) if PREFERENCES.is_file() else {})
        elif route == "/api/projects":
            items = []
            for path in PROJECTS.glob("*.json"):
                try:
                    stored = json.loads(path.read_text(encoding="utf-8"))
                    items.append({"name": stored["name"], "updated": stored["updated"]})
                except (OSError, ValueError, KeyError):
                    continue
            self.json({"projects": sorted(items, key=lambda item: item["updated"], reverse=True)})
        elif route == "/api/project":
            path = project_path(query.get("name", ""))
            if not path.is_file():
                raise FileNotFoundError("没有找到这个工程。")
            stored = json.loads(path.read_text(encoding="utf-8"))
            state = stored.get("state")
            if not isinstance(state, dict):
                raise ValueError("工程数据有误。")
            validate_project_state(state, check_originals=True)
            self.json(stored)
        else:
            self.json({"error": "地址不存在。"}, HTTPStatus.NOT_FOUND)

    def post(self, route: str, query: dict):
        if route == "/api/import":
            self.import_photo(query.get("name", ""))
        elif route == "/api/white-balance":
            request = self.json_body()
            photo_id = request.get("id")
            with IMAGE_JOBS:
                settings = sample_white_balance(render_source(photo_id),
                                                request.get("x"), request.get("y"))
            self.json(settings)
        elif route == "/api/lut":
            self.import_lut(query.get("name", ""))
        elif route == "/api/preferences":
            request = self.json_body()
            luts = request.get("luts", [])
            favorites = request.get("favorites", [])
            presets = request.get("presets", {})
            if not isinstance(presets, dict):
                raise ValueError("预设数据格式有误。")
            groups = {key: presets.get(key, []) for key in ("landscape", "portrait")}
            if any(not isinstance(value, list) or len(value) > 1000
                   for value in (luts, favorites, *groups.values())):
                raise ValueError("风格或预设数据格式有误。")
            stored = {"luts": luts, "favorites": favorites, "presets": groups}
            atomic_write(PREFERENCES, json.dumps(stored, ensure_ascii=False).encode())
            self.json({"ok": True})
        elif route == "/api/project":
            request = self.json_body()
            name, state = request.get("name"), request.get("state")
            path = project_path(name)
            if not isinstance(state, dict):
                raise ValueError("工程数据有误。")
            validate_project_state(state)
            content = {"name": name.strip(), "state": state,
                       "updated": datetime.now().astimezone().isoformat(timespec="seconds")}
            atomic_write(path, json.dumps(content, ensure_ascii=False).encode())
            self.json({"ok": True})
        elif route in ("/api/render", "/api/export", "/api/editor"):
            self.process(route, self.json_body())
        else:
            self.close_connection = True
            self.json({"error": "地址不存在。"}, HTTPStatus.NOT_FOUND)

    def import_photo(self, uploaded_name: str):
        name = clean_filename(uploaded_name)
        suffix = Path(name).suffix.lower()
        if suffix not in (RAW | RASTER):
            self.close_connection = True
            raise ValueError("请选择 JPG、PNG、TIFF 或支持的相机 RAW 文件。")
        content = self.body(150 * 1024 * 1024)
        photo_id = hashlib.sha256(content).hexdigest() + suffix
        path = PHOTOS / photo_id
        with IMAGE_JOBS:
            created = not path.is_file()
            if created:
                atomic_write(path, content)
            try:
                thumb(photo_id)
            except (ValueError, OSError, RuntimeError, Image.DecompressionBombError) as error:
                if created:
                    path.unlink(missing_ok=True)
                    (DECODED / (path.name + ".tif")).unlink(missing_ok=True)
                raise ValueError(f"无法打开 {name}。{error}") from error
        self.json({"id": photo_id, "name": name, "raw": suffix in RAW})

    def import_lut(self, uploaded_name: str):
        name = clean_filename(uploaded_name)
        if Path(name).suffix.lower() != ".cube":
            self.close_connection = True
            raise ValueError("请选择 .cube 3D LUT。")
        content = self.body(12 * 1024 * 1024)
        lut_id = hashlib.sha256(content).hexdigest()
        path = LUTS / (lut_id + ".cube")
        if not path.is_file():
            with tempfile.TemporaryDirectory(dir=LUTS) as temporary:
                staged = Path(temporary) / "style.cube"
                staged.write_bytes(content)
                validate_lut(staged)
                os.replace(staged, path)
        self.json({"id": lut_id, "name": name})

    def process(self, route: str, request: dict):
        photo_id = request.get("id")
        settings = request.get("settings", {})
        if not isinstance(settings, dict):
            raise ValueError("调整参数格式有误。")
        lut = lut_path(request.get("lutId"))
        if route == "/api/render":
            resolution = request.get("resolution", "preview")
            if resolution not in ("preview", "full"):
                raise ValueError("预览分辨率无效。")
            with IMAGE_JOBS:
                data = render(render_source(photo_id), settings, lut, "jpeg",
                              preview=resolution == "preview")
            self.respond(data, "image/jpeg")
            return

        editor = route == "/api/editor"
        if editor and not capabilities().get("patchy"):
            raise ValueError("未找到 Patchy。请把官方便携版解压到 Tools\\Patchy，再重试。")
        output_format = "tiff" if editor else request.get("format")
        if not isinstance(output_format, str) or output_format not in FORMATS:
            raise ValueError("请选择 JPG、16 位 TIFF 或 PSD。")
        name = Path(clean_filename(str(request.get("name") or "照片"))).stem[:65]
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        destination = (HANDOFF if editor else OUTPUT) / f"{name}-{timestamp}{FORMATS[output_format]}"
        with IMAGE_JOBS:
            source = render_source(photo_id)
            if output_format == "psd":
                data = make_psd(source, settings, lut)
            else:
                data = render(source, settings, lut, output_format)
            atomic_write(destination, data)
        if editor:
            open_in_patchy(destination)
        self.json({"ok": True, "file": str(destination)})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=17841)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--debug", action="store_true")
    arguments = parser.parse_args()
    for folder in (PHOTOS, DECODED, THUMBS, LUTS, PROJECTS, OUTPUT, HANDOFF):
        folder.mkdir(parents=True, exist_ok=True)
    try:
        server = ThreadingHTTPServer(("127.0.0.1", arguments.port), WorkbenchHandler)
    except OSError:
        if arguments.port != 17841:
            raise
        server = ThreadingHTTPServer(("127.0.0.1", 0), WorkbenchHandler)
    server.debug = arguments.debug
    url = f"http://127.0.0.1:{server.server_port}/"
    print(f"Chromora  {url}", flush=True)
    print(f"数据目录  {ROOT}", flush=True)
    print("关闭此窗口会退出工作台。", flush=True)
    if not arguments.no_browser:
        threading.Timer(0.25, webbrowser.open, args=(url,)).start()
    with server:
        try:
            server.serve_forever(poll_interval=0.25)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
