"""Exercises remote launches with real child processes and isolated caches."""
import io
import json
import os
from pathlib import Path
import queue
import stat
import tarfile
import tempfile
import threading
import time
import unittest
import zipfile
from unittest.mock import patch

root = Path(__file__).resolve().parents[1]
namespace = {'__name__': 'application_test'}
exec((root / 'src/main/remote-helper.py').read_text(), namespace)
Applications, VSCode, Launch = (namespace[name] for name in ('Applications', 'VSCode', 'Launch'))

class ApplicationsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.environment = patch.dict(os.environ, XDG_CACHE_HOME=str(self.directory / 'cache'), XDG_DATA_HOME=str(self.directory / 'data'))
        self.environment.start()
        self.events = queue.Queue()
        self.seen = []
        self.manager = Applications(self.events.put)
        self.offline = patch.object(VSCode, 'release', side_effect=OSError('offline'))
        self.offline.start()

    def tearDown(self):
        self.manager.close()
        self.offline.stop()
        self.environment.stop()
        self.temporary.cleanup()

    def cache(self, version, complete=True):
        target = self.directory / 'cache/bartizan/tools/vscode' / version
        target.mkdir(parents=True)
        (target / 'code').write_text((root / 'tests/fixtures/application.py').read_text())
        (target / 'code').chmod(0o700)
        (target / 'release.json').write_text(json.dumps({'name': version, 'version': 'a' * 40}))
        if complete:
            (target / 'complete').touch()
        return target

    def event(self, kind):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            event = self.events.get(timeout=max(.01, deadline - time.monotonic()))
            self.seen.append(event)
            if event['type'] == 'applications.' + kind:
                return event
            if event['type'] == 'applications.ended':
                self.fail(event)
        self.fail('Missing event ' + kind)

    def launch(self, identifier='test'):
        self.manager.request(dict(type='applications.launch', launchId=identifier, application='vscode'))

    def test_cached_launch_consent_and_cleanup(self):
        self.cache('1.9.0'); self.cache('1.10.0'); self.cache('1.11.0', complete=False)
        self.launch()
        consent = self.event('consent')
        self.assertEqual(consent['content']['text'], 'Fixture application terms https://example.com/terms')
        installing = [event for event in self.seen if event['type'] == 'applications.progress']
        self.assertEqual(installing[0], dict(type='applications.progress', launchId='test', phase='checking', component='Visual Studio Code Launcher'))
        # Falling back to a cached release stays reported for the rest of the launch.
        self.assertTrue(all(event.get('usingCachedRelease') for event in installing[1:]), installing)
        self.assertEqual(installing[-1]['component'], 'Visual Studio Code')
        self.manager.request(dict(type='applications.respond', launchId='test', consentId='stale', accepted=True))
        with self.assertRaises(queue.Empty): self.events.get(timeout=.2)
        self.manager.request(dict(type='applications.respond', launchId='test', consentId=consent['consentId'], accepted=True))
        transfers, phases, components, fallbacks = [], [], [], []
        deadline = time.monotonic() + 8
        while True:
            ready = self.events.get(timeout=max(.01, deadline - time.monotonic()))
            self.assertLess(time.monotonic(), deadline)
            if ready['type'] == 'applications.ready':
                break
            self.assertNotEqual(ready['type'], 'applications.ended', ready)
            if ready['type'] == 'applications.progress':
                phases.append(ready['phase'])
                components.append(ready.get('component'))
                fallbacks.append(ready.get('usingCachedRelease'))
            if 'transfer' in ready:
                transfers.append(ready['transfer'])
        self.assertIn('extracting', phases)
        self.assertIn('starting', phases)
        self.assertNotIn('downloading', phases[phases.index('extracting'):])
        self.assertIn(dict(receivedBytes=25), transfers)
        self.assertIn(dict(receivedBytes=50, totalBytes=100), transfers)
        # The launcher fetches and runs the server itself, so that stretch of the launch reports on the server.
        self.assertEqual([name for index, name in enumerate(components) if index == 0 or name != components[index - 1]],
                         ['Visual Studio Code', 'Visual Studio Code Server', 'Visual Studio Code'])
        self.assertTrue(all(fallbacks), fallbacks)
        self.assertEqual(ready['release'], '1.10.0')
        self.assertIn('127.0.0.1:', ready['view']['url'])
        pid = int((self.directory / 'data/bartizan/tools/vscode/server-data/fixture.pid').read_text())
        self.manager.request(dict(type='applications.stop', launchId='test'))
        self.assertEqual(self.event('ended')['reason'], 'stopped')
        with self.assertRaises(ProcessLookupError): os.kill(pid, 0)
        self.launch('again')
        self.assertEqual(self.event('ready')['release'], '1.10.0')

    def test_decline_and_missing_cache(self):
        self.launch()
        self.assertIn('no complete cached', self.event('ended')['error']['message'])
        self.cache('1.0.0')
        self.launch('decline')
        consent = self.event('consent')
        self.manager.request(dict(type='applications.respond', launchId='decline', consentId=consent['consentId'], accepted=False))
        self.assertEqual(self.event('ended')['reason'], 'cancelled')
        self.assertFalse((self.directory / 'data/bartizan/tools/vscode/consent').exists())

    def test_independent_pending_consent(self):
        self.cache('1.0.0')
        self.launch('first')
        first = self.event('consent')
        self.launch('second')
        second = self.event('consent')
        self.assertNotEqual(first['launchId'], second['launchId'])
        self.manager.request(dict(type='applications.respond', launchId='second', consentId=second['consentId'], accepted=True))
        self.assertEqual(self.event('ready')['launchId'], 'second')
        self.manager.request(dict(type='applications.stop', launchId='first'))
        self.assertEqual(self.event('ended')['reason'], 'cancelled')
        self.assertTrue(self.manager.launches['second'].process.poll() is None)

    def test_verified_download_and_atomic_cache(self):
        for archive_format in ('tar', 'zip'):
            with self.subTest(archive_format=archive_format):
                import hashlib
                launch = Launch(self.manager, dict(launchId='download', application='vscode'))
                payload = b'#!/bin/sh\necho fixture\n'
                archive = io.BytesIO()
                if archive_format == 'zip':
                    with zipfile.ZipFile(archive, 'w') as output:
                        member = zipfile.ZipInfo('code'); member.external_attr = (stat.S_IFREG | 0o755) << 16
                        output.writestr(member, payload)
                else:
                    with tarfile.open(fileobj=archive, mode='w:gz') as output:
                        member = tarfile.TarInfo('code'); member.size = len(payload); member.mode = 0o700
                        output.addfile(member, io.BytesIO(payload))
                content = archive.getvalue()
                release = dict(name='1.2.3', version='a' * 40, url='https://example.com/archive', sha256hash=hashlib.sha256(content).hexdigest())
                def response(*args, **kwargs):
                    result = io.BytesIO(content); result.url = release['url']; result.headers = {'Content-Length': str(len(content))}
                    return result
                cache = self.directory / archive_format
                with patch('urllib.request.urlopen', side_effect=response) as download:
                    directory, installed = launch.install(cache, lambda: release, 'code')
                    self.assertEqual((directory / 'code').read_bytes(), payload)
                    self.assertEqual((directory / 'code').stat().st_mode & 0o777, 0o700)
                    self.assertEqual(installed, release)
                    launch.resources.close()
                    launch.install(cache, lambda: {**release, 'notes': 'changed'}, 'code')
                    launch.resources.close()
                    self.assertEqual(download.call_count, 1)
                    self.assertFalse((directory / 'complete').exists())
                    bad = {**release, 'name': '1.2.4', 'sha256hash': '0' * 64}
                    with self.assertRaisesRegex(ValueError, 'checksum'):
                        launch.install(cache, lambda: bad, 'code')
                    self.assertFalse((cache / '1.2.4').exists())
                    self.assertFalse(list(cache.glob('.download-*')))
                    launch.install(cache, lambda: release, 'code')
                    (directory / 'code').chmod(0o600)
                    before = download.call_count
                    repair = Launch(self.manager, dict(launchId='repair', application='vscode'))
                    result = queue.Queue()
                    def repair_cache():
                        try:
                            result.put(repair.install(cache, lambda: release, 'code'))
                        except Exception as error:
                            result.put(error)
                        finally:
                            repair.resources.close()
                    worker = threading.Thread(target=repair_cache)
                    worker.start()
                    try:
                        with self.assertRaises(queue.Empty): result.get(timeout=.2)
                        self.assertEqual(download.call_count, before)
                    finally:
                        launch.resources.close()
                    self.assertIsInstance(result.get(timeout=3), tuple)
                    worker.join(timeout=3)
                    self.assertFalse(worker.is_alive())
                    self.assertEqual(download.call_count, before + 1)
                    self.assertTrue(os.access(directory / 'code', os.X_OK))

    def test_unsafe_archive_and_cache_path(self):
        launch = Launch(self.manager, dict(launchId='test', application='vscode'))
        archive = self.directory / 'unsafe.tar'
        with tarfile.open(archive, 'w') as output:
            member = tarfile.TarInfo('../escape'); member.size = 1
            output.addfile(member, io.BytesIO(b'x'))
        with self.assertRaisesRegex(ValueError, 'Unsafe archive'): launch.extract(archive, self.directory / 'out')
        with patch.dict(os.environ, XDG_CACHE_HOME='relative'):
            self.assertEqual(namespace['xdg']('XDG_CACHE_HOME', '.cache'), Path.home() / '.cache')

    def test_zip_entries(self):
        launch = Launch(self.manager, dict(launchId='zip', application='vscode'))
        archive, destination = self.directory / 'archive.zip', self.directory / 'out'
        for name, mode in [('../escape', stat.S_IFREG), ('/escape', stat.S_IFREG),
                           ('link', stat.S_IFLNK), ('fifo', stat.S_IFIFO)]:
            with self.subTest(name=name):
                with zipfile.ZipFile(archive, 'w') as output:
                    member = zipfile.ZipInfo(name); member.external_attr = (mode | 0o755) << 16
                    output.writestr(member, b'target')
                with self.assertRaisesRegex(ValueError, 'Unsafe archive'):
                    launch.extract(archive, destination)
                self.assertFalse(destination.exists())
        with zipfile.ZipFile(archive, 'w') as output:
            output.writestr('nested/', b'')
            output.writestr('nested/notice', b'terms')
        launch.extract(archive, destination)
        self.assertEqual((destination / 'nested/notice').read_bytes(), b'terms')
        self.assertEqual((destination / 'nested/notice').stat().st_mode & 0o777, 0o600)
        with zipfile.ZipFile(archive) as source:
            entries = source.infolist()
        entries[-1].file_size = 1024 * 1024 * 1024 + 1
        with patch.object(zipfile.ZipFile, 'infolist', return_value=entries):
            with self.assertRaisesRegex(ValueError, 'Archive is too large'):
                launch.extract(archive, destination)
        def cancel_entries(source):
            launch.cancel.set()
            return entries
        with patch.object(zipfile.ZipFile, 'infolist', cancel_entries):
            with self.assertRaises(namespace['Cancelled']):
                launch.extract(archive, destination)

    def test_tar_with_zip_trailer(self):
        launch = Launch(self.manager, dict(launchId='tar', application='vscode'))
        archive, destination = self.directory / 'archive', self.directory / 'out'
        payload = b'code PK\x05\x06' + bytes(18)
        with tarfile.open(archive, 'w:gz', compresslevel=0) as output:
            member = tarfile.TarInfo('code'); member.size = len(payload); member.mode = 0o755
            output.addfile(member, io.BytesIO(payload))
        launch.extract(archive, destination)
        self.assertEqual((destination / 'code').read_bytes(), payload)
        self.assertEqual((destination / 'code').stat().st_mode & 0o777, 0o700)

    def test_release_platforms(self):
        self.offline.stop()
        launch = Launch(self.manager, dict(launchId='platform', application='vscode'))
        release = dict(name='1.2.3', version='a' * 40, sha256hash='b' * 64)
        for system, machine, target in [('Linux', 'x86_64', 'cli-linux-x64'),
                                        ('Linux', 'aarch64', 'cli-linux-arm64'),
                                        ('Linux', 'armv7l', 'cli-linux-armhf'),
                                        ('Darwin', 'x86_64', 'cli-darwin-x64'),
                                        ('Darwin', 'arm64', 'cli-darwin-arm64')]:
            with self.subTest(system=system, machine=machine), patch('platform.system', return_value=system), \
                    patch('platform.machine', return_value=machine), \
                    patch('urllib.request.urlopen', return_value=io.BytesIO(json.dumps(release).encode())) as request:
                self.assertEqual(VSCode(launch).release(), release)
                request.assert_called_once_with('https://update.code.visualstudio.com/api/update/' + target + '/stable/latest', timeout=10)
        for system, machine in [('Windows', 'x86_64'), ('Darwin', 'armv7l'), ('Linux', 'unknown')]:
            with self.subTest(system=system, machine=machine), patch('platform.system', return_value=system), \
                    patch('platform.machine', return_value=machine), patch('urllib.request.urlopen') as request:
                with self.assertRaisesRegex(ValueError, 'supported Linux or macOS architecture'):
                    VSCode(launch).release()
                request.assert_not_called()

if __name__ == '__main__':
    unittest.main()
