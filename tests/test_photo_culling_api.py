"""Project persistence tests for photo ratings and pick/reject flags."""

from __future__ import annotations

from hashlib import sha256
from http.client import HTTPConnection
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from threading import Thread
from urllib.parse import quote
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import server as chromora_server  # noqa: E402


class PhotoCullingProjectApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = TemporaryDirectory(prefix="chromora-photo-culling-api-")
        cls.root = Path(cls.temp.name)
        cls._patchers = []
        for name in ("PHOTOS", "PROJECTS"):
            path = cls.root / name
            path.mkdir(parents=True, exist_ok=True)
            patcher = patch.object(chromora_server, name, path)
            patcher.start()
            cls._patchers.append(patcher)

        cls.photo_id = sha256(b"photo culling source").hexdigest() + ".jpg"
        (chromora_server.PHOTOS / cls.photo_id).write_bytes(b"source placeholder")
        cls.httpd = chromora_server.ThreadingHTTPServer(
            ("127.0.0.1", 0), chromora_server.WorkbenchHandler
        )
        cls.httpd.debug = False
        cls.thread = Thread(
            target=cls.httpd.serve_forever,
            kwargs={"poll_interval": 0.01},
            daemon=True,
        )
        cls.thread.start()
        cls.host, cls.port = cls.httpd.server_address

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=2)
        for patcher in reversed(cls._patchers):
            patcher.stop()
        cls.temp.cleanup()

    def request(self, method: str, path: str, payload=None):
        headers = {}
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        else:
            body = None
        connection = HTTPConnection(self.host, self.port, timeout=15)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def base_state(self, photo: dict | None = None) -> dict:
        item = {"id": self.photo_id, "name": "sample.jpg", "settings": {}, "lutId": None}
        if photo:
            item.update(photo)
        return {"photos": [item], "currentId": self.photo_id, "luts": [], "favorites": []}

    def save_project(self, name: str, state: dict):
        return self.request("POST", "/api/project", {"name": name, "state": state})

    def load_project(self, name: str):
        return self.request("GET", "/api/project?name=" + quote(name, safe=""))

    def test_rating_and_flag_survive_project_save_and_reopen(self):
        state = self.base_state({"rating": 5, "flag": "pick"})
        status, body = self.save_project("culling-roundtrip", state)
        self.assertEqual(status, 200, body.decode("utf-8", "replace"))

        status, body = self.load_project("culling-roundtrip")
        self.assertEqual(status, 200, body.decode("utf-8", "replace"))
        stored = json.loads(body)
        self.assertEqual(stored["state"]["photos"][0]["rating"], 5)
        self.assertEqual(stored["state"]["photos"][0]["flag"], "pick")

        state["photos"][0].update(rating=2, flag="reject")
        status, body = self.save_project("culling-roundtrip", state)
        self.assertEqual(status, 200, body.decode("utf-8", "replace"))
        status, body = self.load_project("culling-roundtrip")
        self.assertEqual(status, 200, body.decode("utf-8", "replace"))
        restored = json.loads(body)["state"]["photos"][0]
        self.assertEqual((restored["rating"], restored["flag"]), (2, "reject"))

    def test_legacy_projects_without_culling_fields_still_open(self):
        state = self.base_state()
        status, body = self.save_project("legacy-without-culling", state)
        self.assertEqual(status, 200, body.decode("utf-8", "replace"))

        status, body = self.load_project("legacy-without-culling")
        self.assertEqual(status, 200, body.decode("utf-8", "replace"))
        restored = json.loads(body)["state"]["photos"][0]
        self.assertNotIn("rating", restored)
        self.assertNotIn("flag", restored)

    def test_invalid_ratings_are_rejected(self):
        for value in (-1, 6, 1.5, True, "3", None):
            with self.subTest(rating=value):
                status, body = self.save_project(
                    "invalid-rating-" + str(value), self.base_state({"rating": value})
                )
                self.assertEqual(status, 400, body.decode("utf-8", "replace"))

    def test_invalid_flags_are_rejected(self):
        for value in ("maybe", "favorite", 1, False, []):
            with self.subTest(flag=value):
                status, body = self.save_project(
                    "invalid-flag-" + str(value), self.base_state({"flag": value})
                )
                self.assertEqual(status, 400, body.decode("utf-8", "replace"))


if __name__ == "__main__":
    unittest.main()
