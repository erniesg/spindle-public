"""Producer cache configuration guard, not Windows UIA execution."""
import re
import unittest
from pathlib import Path

class PreviewContentCacheTest(unittest.TestCase):
    def test_enumeration_does_not_prefetch_content(self):
        source=(Path(__file__).resolve().parents[1]/'platforms/windows/Preview.cs').read_text(encoding='utf-8')
        properties=re.search(r'foreach\(var property in new\[\]\{([^}]+)\}\)metadata.Add\(property\)',source).group(1)
        self.assertNotIn('AutomationElement.NameProperty',properties,'Offscreen nodes must be excluded before their Name is requested')
        self.assertNotIn('AutomationElement.HelpTextProperty',properties)
        self.assertNotIn('AutomationElement.ValueProperty',properties)
        for required in ['ProcessIdProperty','IsOffscreenProperty','IsPasswordProperty','ControlTypeProperty']:
            self.assertIn(required,properties)
