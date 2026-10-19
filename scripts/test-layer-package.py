#!/usr/bin/env python3
import importlib.util
import json
import pathlib
import tempfile
import unittest
import zipfile
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('package_auth_layer',ROOT/'scripts/package-auth-layer.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class LayerPackage(unittest.TestCase):
    def test_real_arm64_zip_and_permissions(self):
        binary=ROOT/'target/aarch64-unknown-linux-gnu/release/event-auth'
        self.assertTrue(binary.exists(),'Run scripts/build-auth-layer.sh demo first')
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);output=root/'layer.zip'
            module.package(binary,output)
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(archive.namelist(),['bin/event-auth'])
                self.assertEqual(archive.getinfo('bin/event-auth').external_attr>>16&0o777,0o755)
                self.assertEqual(archive.read('bin/event-auth'),binary.read_bytes())
            config=json.loads((ROOT/'examples/jwt/config.example.json').read_text())
            (root/'config.json').write_text(json.dumps(config))
            (root/'jwks.json').write_text((ROOT/'crates/event-auth-jwt/tests/fixtures/jwks.json').read_text())
            module.package(binary,output,root)
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(set(archive.namelist()),{'bin/event-auth','event-auth/config.json','event-auth/jwks.json'})
            jwks=json.loads((root/'jwks.json').read_text());jwks['keys'][0]['d']='private'
            (root/'jwks.json').write_text(json.dumps(jwks))
            with self.assertRaises(ValueError):module.package(binary,output,root)
    def test_wrong_architecture_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):module.package(ROOT/'target/debug/event-auth',pathlib.Path(directory)/'wrong.zip')
if __name__=='__main__':unittest.main()
