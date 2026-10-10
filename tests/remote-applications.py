"""Exercises remote launches with real child processes and isolated caches."""
import io
import json
import os
from pathlib import Path
import queue
import signal
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
import urllib.request
import zipfile
from unittest.mock import patch

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'src/main/remote-helper'))
from helper.applications import Applications, Launch, Cancelled, stop, xdg
from helper.t3 import T3, answers, pairing, base_dir
from helper.vscode import VSCode

class ApplicationsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.environment = patch.dict(os.environ, XDG_CACHE_HOME=str(self.directory / 'cache'), XDG_DATA_HOME=str(self.directory / 'data'))
        self.environment.start()
        self.events = queue.Queue()
        self.seen = []
        self.manager = Applications(self.events.put, {"vscode": VSCode})
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
            self.assertEqual(xdg('XDG_CACHE_HOME', '.cache'), Path.home() / '.cache')

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
            with self.assertRaises(Cancelled):
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

class T3Test(unittest.TestCase):
    """Every launch here sees only a private home and a fixture `t3`, never an installed one."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.home, self.bin = self.directory / 'home', self.directory / 'bin'
        for directory in (self.home, self.bin):
            directory.mkdir()
        self.environment = patch.dict(os.environ, HOME=str(self.home), PATH=str(self.bin) + ':/usr/bin:/bin', XDG_CACHE_HOME=str(self.directory / 'cache'))
        self.environment.start()
        os.environ.pop('T3CODE_HOME', None)
        self.events = queue.Queue()
        self.seen = []
        self.manager = Applications(self.events.put, {"t3": T3})
        self.external = None
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def tearDown(self):
        self.manager.close()
        if self.external:
            self.external.kill(); self.external.wait()
        self.environment.stop()
        self.temporary.cleanup()

    def install(self, target=None):
        target = target or self.bin / 't3'
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text((root / 'tests/fixtures/t3.py').read_text())
        target.chmod(0o700)
        return target

    def event(self, identifier, kind):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            event = self.events.get(timeout=max(.01, deadline - time.monotonic()))
            self.seen.append(event)
            if event.get('launchId') != identifier:
                continue
            if event['type'] == 'applications.' + kind:
                return event
            if event['type'] == 'applications.ended':
                self.fail(event)
        self.fail('Missing event ' + kind)

    def launch(self, identifier):
        self.manager.request(dict(type='applications.launch', launchId=identifier, application='t3'))

    def starts(self):
        try:
            return [json.loads(line) for line in (self.home / '.t3/userdata/serve.log').read_text().splitlines()]
        except OSError:
            return []

    def runtime(self):
        return json.loads((self.home / '.t3/userdata/server-runtime.json').read_text())

    def pair(self, url):
        token = url.split('#token=', 1)[1]
        request = urllib.request.Request(url.split('/pair', 1)[0] + '/api/auth/browser-session', data=json.dumps(dict(credential=token)).encode(), method='POST')
        with self.opener.open(request, timeout=5) as response:
            return response.headers['Set-Cookie'].split(';', 1)[0]

    def ended(self, *identifiers):
        """The reasons the launches given end for, which end without an error."""
        reasons = {}
        while set(reasons) != set(identifiers):
            event = self.events.get(timeout=15)
            self.seen.append(event)
            if event['type'] == 'applications.ended' and event['launchId'] in identifiers:
                self.assertNotIn('error', event)
                reasons[event['launchId']] = event['reason']
        return reasons

    def drain(self):
        while True:
            try:
                self.seen.append(self.events.get_nowait())
            except queue.Empty:
                return self.seen

    def stop(self, identifier):
        self.manager.request(dict(type='applications.stop', launchId=identifier))
        self.assertEqual(self.event(identifier, 'ended')['reason'], 'stopped')

    def test_not_installed(self):
        self.assertIsNone(shutil.which('t3'))
        (self.home / '.local/bin').mkdir(parents=True)
        (self.home / '.local/bin/t3').write_text('')
        self.launch('missing')
        ended = self.events.get(timeout=8)
        while ended['type'] != 'applications.ended':
            ended = self.events.get(timeout=8)
        self.assertEqual((ended['reason'], ended['error']['message']), ('failed', 'T3 Code is not installed'))
        # The user's own programs count as installed when the login path leaves them out.
        self.install(self.home / '.local/bin/t3')
        self.launch('fallback')
        self.assertIn('/pair#token=', self.event('fallback', 'ready')['view']['url'])

    def test_launches_share_a_server_until_the_last_ends(self):
        self.install()
        self.launch('one')
        url = self.event('one', 'ready')['view']['url']
        self.assertEqual([event['component'] for event in self.seen if event['type'] == 'applications.progress'], ['T3 Code', 'T3 Code'])
        origin = 'http://127.0.0.1:{}'.format(self.runtime()['port'])
        self.assertTrue(url.startswith(origin + '/pair#token='), url)
        starts = self.starts()
        self.assertEqual(len(starts), 1)
        self.assertEqual((starts[0]['cwd'], starts[0]['directory']), (str(self.home), str(self.home)))
        server = self.runtime()['pid']
        self.assertEqual([event['pid'] for event in self.seen if event['type'] == 'applications.spawned'], [server])
        # A second launch shares the running server and pairs on its own.
        self.launch('two')
        second = self.event('two', 'ready')['view']['url']
        self.assertTrue(second.startswith(origin + '/pair#token='))
        self.assertNotEqual(second, url)
        self.assertEqual(len(self.starts()), 1)
        self.assertEqual([event['pid'] for event in self.seen if event['type'] == 'applications.spawned'], [server])
        self.pair(url)
        self.pair(second)
        # The server outlasts the launch that started it while another uses it.
        self.stop('one')
        os.kill(server, 0)
        self.launch('three')
        self.event('three', 'ready')
        self.stop('two')
        os.kill(server, 0)
        self.stop('three')
        with self.assertRaises(ProcessLookupError): os.kill(server, 0)
        self.assertFalse((self.home / '.t3/userdata/server-runtime.json').exists())
        self.assertEqual(self.manager.servers, {})
        self.assertEqual(len(self.starts()), 1)

    def test_server_that_goes_away_ends_its_launches(self):
        self.install()
        self.launch('one')
        self.event('one', 'ready')
        self.launch('two')
        self.event('two', 'ready')
        os.kill(self.runtime()['pid'], signal.SIGTERM)
        self.assertEqual(self.ended('one', 'two'), {'one': 'exited', 'two': 'exited'})
        # One that crashes ends them the same way.
        self.launch('three')
        self.event('three', 'ready')
        self.assertEqual(len(self.starts()), 2)
        os.kill(self.runtime()['pid'], signal.SIGKILL)
        self.assertEqual(self.ended('three'), {'three': 'exited'})
        self.assertEqual(self.manager.servers, {})

    def test_launches_at_once_share_one_server(self):
        self.install()
        self.launch('one')
        self.launch('two')
        ready = set()
        while ready != {'one', 'two'}:
            event = self.events.get(timeout=15)
            self.seen.append(event)
            self.assertNotEqual(event['type'], 'applications.ended', event)
            if event['type'] == 'applications.ready':
                ready.add(event['launchId'])
        self.assertEqual(len(self.starts()), 1)
        self.assertEqual(self.manager.servers['t3'].users, {'one', 'two'})
        self.assertEqual([event['pid'] for event in self.seen if event['type'] == 'applications.spawned'], [self.runtime()['pid']])

    def test_launch_waits_for_a_stopping_server(self):
        self.install()
        self.launch('one')
        self.event('one', 'ready')
        server = self.runtime()['pid']
        release = threading.Event()
        def held(process, grace):
            release.wait(8)
            stop(process, grace)
        with patch('helper.t3.stop', held):
            self.manager.request(dict(type='applications.stop', launchId='one'))
            deadline = time.monotonic() + 8
            while not self.manager.servers['t3'].stopping:
                self.assertLess(time.monotonic(), deadline); time.sleep(.01)
            self.launch('two')
            time.sleep(.5)
            self.assertFalse(any(event.get('launchId') == 'two' and event['type'] == 'applications.ready' for event in self.drain()))
            os.kill(server, 0)
            release.set()
            self.event('two', 'ready')
        with self.assertRaises(ProcessLookupError): os.kill(server, 0)
        self.assertEqual(len(self.starts()), 2)
        self.assertEqual(self.manager.servers['t3'].process.pid, self.runtime()['pid'])

    def test_launch_cancelled_while_starting_a_server(self):
        self.install()
        started = threading.Event()
        def answering(url, timeout=3):
            # A server answers its root only once the test lets it.
            return started.is_set() if url.endswith('/') else answers(url, timeout)
        with patch('helper.t3.answers', answering):
            self.launch('one')
            deadline = time.monotonic() + 8
            while not self.starts():
                self.assertLess(time.monotonic(), deadline); time.sleep(.01)
            # The second launch waits on the lock the first holds while its server starts.
            self.launch('two')
            time.sleep(.3)
            self.manager.request(dict(type='applications.stop', launchId='one'))
            self.assertEqual(self.event('one', 'ended')['reason'], 'cancelled')
            with self.assertRaises(ProcessLookupError): os.kill(self.starts()[0]['pid'], 0)
            started.set()
            self.event('two', 'ready')
        self.assertEqual(len(self.starts()), 2)
        self.assertEqual(self.manager.servers['t3'].users, {'two'})

    def test_stop_without_lock_directory(self):
        self.install()
        self.launch('one')
        self.event('one', 'ready')
        server = self.runtime()['pid']
        shutil.rmtree(self.directory / 'cache')
        self.stop('one')
        with self.assertRaises(ProcessLookupError): os.kill(server, 0)

    def test_reuse_leaves_server_running(self):
        executable = self.install()
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]
        self.external = subprocess.Popen([str(executable), 'serve', '--host', '127.0.0.1', '--port', str(port), '--base-dir', str(self.home / '.t3'), str(self.home)],
                                         env=dict(os.environ, T3CODE_NO_BROWSER='1'), stdout=subprocess.DEVNULL)
        deadline = time.monotonic() + 8
        while not (self.home / '.t3/userdata/server-runtime.json').exists():
            self.assertLess(time.monotonic(), deadline); time.sleep(.05)
        self.launch('reuse')
        self.assertTrue(self.event('reuse', 'ready')['view']['url'].startswith('http://127.0.0.1:{}/pair#token='.format(port)))
        self.assertFalse(any(event['type'] == 'applications.spawned' for event in self.seen))
        self.assertEqual(self.manager.servers, {})
        self.manager.request(dict(type='applications.stop', launchId='reuse'))
        self.assertEqual(self.event('reuse', 'ended')['reason'], 'stopped')
        self.assertIsNone(self.external.poll())
        self.assertEqual(len(self.starts()), 1)
        # A shared server that goes away ends the launch without a failure.
        self.launch('watch')
        self.event('watch', 'ready')
        self.external.terminate(); self.external.wait()
        ended = self.event('watch', 'ended')
        self.assertEqual(ended['reason'], 'exited')
        self.assertNotIn('error', ended)
        # A record left by a server that is gone starts another.
        (self.home / '.t3/userdata/server-runtime.json').write_text(json.dumps(dict(version=1, pid=self.external.pid, port=port, origin='http://127.0.0.1:{}'.format(port))))
        self.launch('stale')
        self.event('stale', 'ready')
        self.assertEqual(len(self.starts()), 2)
        self.assertNotEqual(self.runtime()['port'], port)

    def test_base_directory(self):
        self.assertEqual(base_dir(), self.home / '.t3')
        with patch.dict(os.environ, T3CODE_HOME=str(self.directory / 'shared')):
            self.assertEqual(base_dir(), self.directory / 'shared')
        # T3 Code expands a leading ~ and resolves the rest against where it starts, which for its servers is home.
        for value, expected in [('relative', self.home / 'relative'), ('~/custom/', self.home / 'custom'), ('~', self.home), (' ', self.home / '.t3'), ('../shared/./t3', self.directory / 'shared/t3')]:
            with self.subTest(value=value), patch.dict(os.environ, T3CODE_HOME=value):
                self.assertEqual(base_dir(), expected)

    def test_pairing_output(self):
        record = lambda url: ('level=INFO message="starting"\n{"partial": \n' + json.dumps(dict(id='1', credential='secret', pairUrl=url), indent=2) + '\n').encode()
        self.assertEqual(pairing(record('http://127.0.0.1:4100/pair#token=secret'), 'http://127.0.0.1:4100'), 'http://127.0.0.1:4100/pair#token=secret')
        for url in ['http://127.0.0.1:4101/pair#token=secret', 'https://127.0.0.1:4100/pair#token=secret', 'http://example.com:4100/pair#token=secret',
                    'http://user:secret@127.0.0.1:4100/pair', 'javascript:secret', None, 4100]:
            with self.subTest(url=url):
                with self.assertRaises(ValueError) as caught:
                    pairing(record(url), 'http://127.0.0.1:4100')
                self.assertNotIn('secret', str(caught.exception))
        with self.assertRaisesRegex(ValueError, 'did not create'):
            pairing(b'{"credential": "secret"}', 'http://127.0.0.1:4100')

if __name__ == '__main__':
    unittest.main()
