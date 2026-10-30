"""Deployment-coordinate contract only, not Windows rendering/DPI acceptance."""
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]


class PreviewManifestTests(unittest.TestCase):
    def test_capture_and_fixture_binary_declares_physical_per_monitor_coordinates(self):
        project = ET.parse(ROOT / 'platforms/windows/Preview.csproj').getroot()
        manifest_name = project.findtext('./PropertyGroup/ApplicationManifest')
        self.assertEqual(manifest_name, 'preview.manifest')
        manifest = ET.parse(ROOT / 'platforms/windows' / manifest_name).getroot()
        awareness = manifest.find('.//{http://schemas.microsoft.com/SMI/2016/WindowsSettings}dpiAwareness')
        self.assertIsNotNone(awareness, 'unaware rendering can mix physical capture bounds with logical drawing')
        self.assertEqual(awareness.text, 'PerMonitorV2')
        fallback = manifest.find('.//{http://schemas.microsoft.com/SMI/2005/WindowsSettings}dpiAware')
        self.assertEqual(fallback.text, 'true/pm')


if __name__ == '__main__':
    unittest.main()
