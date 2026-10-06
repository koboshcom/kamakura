#!/usr/bin/env python3
"""Unit tests need Pillow, not a running desktop. Docker integration still required."""
import importlib.util
from pathlib import Path
import unittest
from PIL import Image

path = Path(__file__).with_name('desktop-worker.py')
spec = importlib.util.spec_from_file_location('worker', path)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class DesktopTest(unittest.TestCase):
    def setUp(self):
        class FakeGUI:
            FAILSAFE = False
        self.gui = FakeGUI()
        self.execute = worker.make_session(self.gui, lambda: None)

    def test_globals_persist_and_text_is_bounded(self):
        self.execute('x = 41')
        self.assertEqual(self.execute('log(x + 1)')['text'], '42\n')
        result = self.execute('print("a" * 50000)')
        self.assertLess(len(result['text']), 16100)
        self.assertIn('truncated', result['text'])
        self.assertTrue(self.gui.FAILSAFE)

    def test_text_sink_does_not_grow_after_cap(self):
        sink = worker.BoundedText()
        sink.write('a' * worker.MAX_TEXT)
        for _ in range(10000):
            sink.write('overflow')
        self.assertEqual(len(sink.parts), 1)
        self.assertTrue(sink.truncated)

    def test_images_are_returned(self):
        result = self.execute('from PIL import Image\ndisplay(Image.new("RGB", (10, 10)))')
        self.assertEqual(len(result['images']), 1)
        self.assertTrue(result['images'][0].startswith('iVBOR'))

    def test_image_count_is_bounded(self):
        result = self.execute('from PIL import Image\nfor i in range(3): display(Image.new("RGB", (10, 10)))')
        self.assertEqual(len(result['images']), 2)
        self.assertEqual(result['error'], 'ValueError')

    def test_session_survives_exceptions(self):
        self.assertEqual(self.execute('raise SystemExit(1)')['error'], 'SystemExit')
        self.assertEqual(self.execute('print("awake")')['text'], 'awake\n')


if __name__ == '__main__':
    unittest.main()
