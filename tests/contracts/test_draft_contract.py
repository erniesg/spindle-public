"""Draft schema and temporal conformance, not native or production acceptance."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools'))
from draft_capture_contract import ContractError, expand_event, load_corpus, replay, validate_event


class DraftContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.corpus = load_corpus()

    def test_canonical_valid_and_invalid_wire_examples(self):
        for example in self.corpus['schemaCases']:
            with self.subTest(example=example['name']):
                event = expand_event(self.corpus, {}, example['event'])
                if example['expectedCode'] is None:
                    validate_event(event)
                else:
                    with self.assertRaises(ContractError) as caught:
                        validate_event(event)
                    self.assertEqual(caught.exception.code, example['expectedCode'])

    def test_canonical_sequences_match_exact_expected_outcomes(self):
        for case in self.corpus['cases']:
            with self.subTest(case=case['name']):
                self.assertEqual(replay(self.corpus, case), case['expected'])

    def test_late_result_stays_on_admitted_visit_and_never_extends_time(self):
        case = next(c for c in self.corpus['cases'] if c['name'] == 'rapid-return-late-result')
        result = replay(self.corpus, case)
        self.assertEqual([v['durationMs'] for v in result['visits']], [2000, 3000, 1000, 4000])
        self.assertEqual(result['visits'][0]['samples'][0]['result']['value'], 'INVENTED_FIRST_A')
        self.assertEqual(result['visits'][2]['samples'], [])

    def test_schema_rejects_payload_on_non_value_state(self):
        example = next(c for c in self.corpus['schemaCases'] if c['name'] == 'valid-result')
        event = expand_event(self.corpus, {}, copy.deepcopy(example['event']))
        event['result'] = {'status': 'denied', 'value': 'DO_NOT_RETAIN'}
        with self.assertRaises(ContractError) as caught:
            validate_event(event)
        self.assertEqual(caught.exception.code, 'SCHEMA_INVALID')

    def test_cli_emits_inspectable_synthetic_outcome_and_rejects_unknown_case(self):
        command = [sys.executable, str(ROOT / 'tools/draft_capture_contract.py')]
        completed = subprocess.run(command + ['--case', 'rapid-return-late-result', '--json'], capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        report = json.loads(completed.stdout)
        self.assertEqual(report['scope'], 'draft synthetic conformance; not native acceptance')
        self.assertEqual(len(report['cases'][0]['outcome']['visits']), 4)
        invalid = subprocess.run(command + ['--case', 'not-a-case'], capture_output=True, text=True)
        self.assertNotEqual(invalid.returncode, 0)
        self.assertNotIn('Traceback', invalid.stderr)


if __name__ == '__main__':
    unittest.main()
