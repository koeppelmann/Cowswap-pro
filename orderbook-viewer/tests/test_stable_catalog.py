import json,unittest
from pathlib import Path
from allocator import STABLES

class StableCatalog(unittest.TestCase):
    def test_gho_uses_canonical_address(self):
        correct='0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f'
        wrong='0x40d16fc0246ae9be2e8f1226bfa7d685309136d'
        catalog=json.loads((Path(__file__).parents[1]/'config-catalog.json').read_text())
        self.assertIn(correct,STABLES)
        self.assertNotIn(wrong,STABLES)
        self.assertIn(correct,catalog['stable_tokens'])
        self.assertIn(correct,catalog['tokens'])
