import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('release-preflight.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

class ReleasePreflightTests(unittest.TestCase):
    def test_notes_require_unique_dated_nonempty_section(self):
        self.assertEqual(release.notes_for('## 1.2.3 - 2026-10-12\n\n- Fix\n\n## 1.2.2 - 2026-10-11\n- Old\n', '1.2.3'), '- Fix\n')
        for text in ['## 1.2.3 - Unreleased\n- Fix', '## 1.2.3 - 2026-10-12\n', '## 1.2.3 - 2026-10-12\n- Fix\n## 1.2.3 - 2026-10-12\n- Duplicate']:
            with self.assertRaises(ValueError): release.notes_for(text, '1.2.3')

    def test_pull_request_checks_cannot_satisfy_push_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            previous = os.getcwd()
            os.chdir(directory)
            try:
                Path('CHANGELOG.md').write_text('## 1.2.3 - 2026-10-12\n- Fix\n')
                Path('package.json').write_text('{"name":"fixture","version":"1.2.3"}')
                def api(path):
                    if '/branches/' in path: return {'protected': True}
                    return {'workflow_runs': [{'head_sha':'a'*40,'event':'pull_request','conclusion':'success'}]}
                with patch.dict(os.environ, {'DRY_RUN':'true','VERSION':'1.2.3','GITHUB_REPOSITORY':'owner/repo','GITHUB_REF':'refs/heads/main','CI_WORKFLOWS':'ci.yml','PACKAGE_NAME':'fixture'}, clear=True), patch.object(release,'git',return_value='a'*40), patch.object(release,'api',side_effect=api):
                    with self.assertRaisesRegex(ValueError,'no green push'): release.main()
            finally: os.chdir(previous)

if __name__ == '__main__': unittest.main()
