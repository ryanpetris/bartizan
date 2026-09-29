import io
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from check_release_archive import check
from version import resolve


class PackagingTests(unittest.TestCase):
    def test_versions(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(resolve(), "0.0.0")
        for value in ("0.0.0", "1.2.3", "100.20.30"):
            with patch.dict(os.environ, BARTIZAN_VERSION=value):
                self.assertEqual(resolve(), value)
        for value in ("", "v1.2.3", "01.2.3", "1.2", "1.2.3-beta", "1.2.3\n", "../1.2.3"):
            with patch.dict(os.environ, BARTIZAN_VERSION=value), self.assertRaises(ValueError):
                resolve()

    def archive(self, path, extra=None, version=b"1.2.3\n", header=None, omit=None):
        prefix = "bartizan-1.2.3-linux-x64/"
        elf = b"\x7fELF\x02\x01" + bytes(12) + b"\x3e\x00"
        with tarfile.open(path, "w:gz") as archive:
            files = {"VERSION": version, "bartizan": header or elf,
                     **{name: b"payload" for name in ("resources/app.asar", "chrome-sandbox", "LICENSE",
                                                    "bartizan.desktop", "bartizan.png", "AppRun")}}
            for name, data in files.items():
                if name == omit:
                    continue
                member = tarfile.TarInfo(prefix + name)
                member.size = len(data)
                member.mode = 0o755 if name == "bartizan" else 0o644
                member.mtime = 12345
                archive.addfile(member, io.BytesIO(data))
            if extra:
                archive.addfile(extra, io.BytesIO(bytes(extra.size)))

    def test_archive_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "release.tar.gz"
            self.archive(path)
            self.assertEqual(check(path, "1.2.3"), 12345)
            for name, mode, kind in (("/outside", 0o644, tarfile.REGTYPE),
                                     ("bartizan-1.2.3-linux-x64/../outside", 0o644, tarfile.REGTYPE),
                                     ("other/file", 0o644, tarfile.REGTYPE),
                                     ("bartizan-1.2.3-linux-x64/VERSION", 0o644, tarfile.REGTYPE),
                                     ("bartizan-1.2.3-linux-x64/link", 0o644, tarfile.SYMTYPE),
                                     ("bartizan-1.2.3-linux-x64/special", 0o4755, tarfile.REGTYPE),
                                     ("bartizan-1.2.3-linux-x64/writable", 0o666, tarfile.REGTYPE)):
                member = tarfile.TarInfo(name)
                member.mode, member.type = mode, kind
                self.archive(path, extra=member)
                with self.subTest(name=name), self.assertRaises(ValueError):
                    check(path, "1.2.3")
            for args in ({"version": b"2.0.0"}, {"header": b"not ELF"}, {"omit": "resources/app.asar"}):
                self.archive(path, **args)
                with self.subTest(args=args), self.assertRaises(ValueError):
                    check(path, "1.2.3")


if __name__ == "__main__":
    unittest.main()
