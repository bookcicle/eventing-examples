#!/usr/bin/env python3
"""Verify Context Layer entrypoints, configuration paths and ARM64 packaging."""
import importlib.util
import json
import pathlib
import tempfile
import unittest
import zipfile
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('package_context_layer',ROOT/'scripts/package-auth-layer.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class ContextLayerPackage(unittest.TestCase):
    def test_transformation_and_authentication_entrypoints_and_public_config(self):
        for binary_name in ['event-context','event-auth-jwt']:
            binary=ROOT/'target/aarch64-unknown-linux-gnu/release'/binary_name
            self.assertTrue(binary.exists(), 'Build context and context-jwt first')
            with tempfile.TemporaryDirectory() as directory:
                root=pathlib.Path(directory);output=root/'layer.zip'
                module.package(binary,output)
                with zipfile.ZipFile(output) as archive:
                    self.assertEqual(archive.namelist(),['bin/event-context'])
                    self.assertEqual(archive.getinfo('bin/event-context').external_attr>>16&0o777,0o755)
                    self.assertEqual(archive.read('bin/event-context'),binary.read_bytes())
                (root/'config.json').write_text((ROOT/'examples/jwt/config.example.json').read_text())
                (root/'jwks.json').write_text((ROOT/'crates/event-auth-jwt/tests/fixtures/jwks.json').read_text())
                module.package(binary,output,root)
                with zipfile.ZipFile(output) as archive:
                    self.assertEqual(set(archive.namelist()),{'bin/event-context','event-context/config.json','event-context/jwks.json'})
                jwks=json.loads((root/'jwks.json').read_text());jwks['keys'][0]['d']='private'
                (root/'jwks.json').write_text(json.dumps(jwks))
                with self.assertRaises(ValueError):module.package(binary,output,root)
    def test_wrong_architecture_and_auth_only_entrypoint_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            output=pathlib.Path(directory)/'wrong.zip'
            with self.assertRaises(ValueError):module.package(ROOT/'target/debug/event-auth-jwt',output)
            with self.assertRaises(ValueError):module.package(ROOT/'target/debug/event-auth-jwt',output,entrypoint='event-auth')
if __name__=='__main__':unittest.main()
