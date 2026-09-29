"""Check an installed desktop package, its native runtime and system libraries."""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--debian", action="store_true")
parser.add_argument("--version", required=True)
args = parser.parse_args()
listing = ["dpkg-query", "-L", "bartizan"] if args.debian else ["pacman", "-Qlq", "bartizan"]
files = [Path(line) for line in subprocess.check_output(listing, text=True).splitlines()]
root = Path("/opt/bartizan")
if Path("/usr/bin/bartizan").resolve() != root / "bartizan":
    raise SystemExit("Launcher must use /opt/bartizan")
required = [root / name for name in ("LICENSE", "VERSION", "resources/app.asar", "chrome-sandbox")]
required += [Path("/usr/share/applications/bartizan.desktop"),
             Path("/usr/share/icons/hicolor/512x512/apps/bartizan.png"),
             Path("/usr/share/doc/bartizan/copyright" if args.debian else "/usr/share/licenses/bartizan/LICENSE")]
for path in required:
    if not path.is_file():
        raise SystemExit(f"Missing installed file: {path}")
if (root / "chrome-sandbox").stat().st_mode & 0o7777 != 0o4755:
    raise SystemExit("Electron sandbox helper must have mode 4755")
if (root / "VERSION").read_text().strip() != args.version:
    raise SystemExit("Unexpected payload version")
subprocess.run(["ssh", "-V"], check=True)
subprocess.run([str(root / "bartizan"), str(Path("scripts/check-pty.cjs").resolve()),
                str(root / "resources/app.asar"), args.version],
               env=dict(os.environ, ELECTRON_RUN_AS_NODE="1"), check=True)
if args.debian:
    profile = Path("/etc/apparmor.d/bartizan").read_text()
    if "/opt/bartizan/bartizan" not in profile or "userns," not in profile:
        raise SystemExit("Missing Electron user namespace AppArmor profile")
elfs = []
for path in files:
    if path.exists() and (path.lstat().st_uid != 0 or path.lstat().st_gid != 0):
        raise SystemExit(f"Unexpected package file owner: {path}")
    if not path.is_file() or path.is_symlink():
        continue
    with path.open("rb") as stream:
        header = stream.read(20)
    if not header.startswith(b"\x7fELF"):
        continue
    if header[4:6] != b"\x02\x01" or header[18:20] != b"\x3e\x00":
        raise SystemExit(f"Unexpected ELF architecture: {path}")
    if "(NEEDED)" not in subprocess.check_output(["readelf", "-d", str(path)], text=True):
        continue
    linked = subprocess.run(["ldd", str(path)], capture_output=True, text=True, check=True)
    if "not found" in linked.stdout + linked.stderr:
        raise SystemExit(f"Unresolved libraries for {path}:\n{linked.stdout}{linked.stderr}")
    elfs.append(path)
if args.debian:
    with tempfile.TemporaryDirectory(prefix="bartizan-shlibs-") as directory:
        temporary = Path(directory)
        (temporary / "debian").mkdir()
        (temporary / "debian/control").write_text("Source: bartizan\n\nPackage: bartizan\nArchitecture: amd64\n")
        result = subprocess.check_output(["dpkg-shlibdeps", "--ignore-missing-info", "-O", "-l/opt/bartizan",
                                          *(f"-e{path}" for path in elfs)], cwd=temporary, text=True)
        dependencies = next(line.removeprefix("shlibs:Depends=") for line in result.splitlines()
                            if line.startswith("shlibs:Depends="))
        declared = subprocess.check_output(["dpkg-query", "-W", "-f=${Depends}", "bartizan"], text=True)
        for requirement in dependencies.split(","):
            if requirement.strip() not in {item.strip() for item in declared.split(",")}:
                raise SystemExit(f"Missing package dependency: {requirement.strip()}")
        subprocess.run(["dpkg-checkbuilddeps", "-I", "-d", declared], cwd=temporary, check=True)
installed = (subprocess.check_output(["dpkg-query", "-W", "-f=${Version}", "bartizan"], text=True) if args.debian
             else subprocess.check_output(["pacman", "-Q", "bartizan"], text=True).split()[1])
if installed.rsplit("-", 1)[0] != args.version:
    raise SystemExit(f"Unexpected package version: {installed}")
print(f"Checked native runtime and {len(elfs)} dynamically linked ELF files")
