#!/usr/bin/env python3
"""Development-only executable draft. Never imported by the capture runtime."""
import argparse
from copy import deepcopy
from functools import lru_cache
import hashlib
import json
from pathlib import Path
import sys

from jsonschema import Draft202012Validator, ValidationError
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / 'tests/fixtures/draft-capture-conformance.json'
VERSION = 'spindle-observation/draft-0'


class ContractError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


@lru_cache(maxsize=1)
def validators():
    schemas = [json.loads((ROOT / 'contracts/draft' / name).read_text(encoding='utf-8'))
               for name in ('observation.schema.json', 'visit.schema.json')]
    registry = Registry()
    for schema in schemas:
        Draft202012Validator.check_schema(schema)
        registry = registry.with_resource(schema['$id'], Resource.from_contents(schema))
    # Registry has no network retriever; only the two local resources resolve.
    return [Draft202012Validator(schema, registry=registry) for schema in schemas]


def validate_event(event):
    if isinstance(event, dict) and 'schema' in event and event['schema'] != VERSION:
        raise ContractError('UNSUPPORTED_SCHEMA')
    try:
        validators()[0].validate(event)
    except ValidationError:
        raise ContractError('SCHEMA_INVALID') from None


def load_corpus():
    return json.loads(CORPUS.read_text(encoding='utf-8'))


def expand_event(corpus, case, event):
    # Fixture shorthand only: fixed defaults, not state-dependent inference.
    wire = deepcopy(corpus['wireDefaults'])
    wire.update(deepcopy(case.get('wireDefaults', {})))
    wire.update(deepcopy(event))
    if isinstance(wire.get('source'), str) and wire['source'] in corpus['sources']:
        wire['source'] = deepcopy(corpus['sources'][wire['source']])
    return wire


class DraftTrace:
    """Finite fake-clock trace, not a collector, scheduler or durable ledger."""
    def __init__(self, defaults, limits):
        self.recording_id = defaults['recordingId']
        self.producer = defaults['producerInstanceId']
        self.clock = defaults['clockDomainId']
        self.fences = deepcopy(defaults['fences'])
        self.limits = limits
        self.recording = True  # A fixture explicitly starts in the recording state.
        self.history_deleted = False
        self.last_at, self.sequence = 0, -1
        self.last_observation = 0
        self.visits, self.rejected, self.gaps = [], [], []
        self.active = None
        self.jobs, self.seen = {}, {}
        self.used_visits, self.used_jobs = set(), set()
        self.used_clocks, self.used_producers = {self.clock}, {self.producer}

    def close_visit(self, at):
        if self.active is not None:
            self.active['endMs'] = at
            self.active['samples'] = [s for s in self.active['samples'] if s['capturedAtMs'] < at]
        self.active = None

    def accept(self, event):
        try:
            validate_event(event)
            digest = hashlib.sha256(json.dumps(event, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()
            if event['eventId'] in self.seen:
                if self.seen[event['eventId']] != digest:
                    raise ContractError('EVENT_ID_CONFLICT')
                return  # Exact replay is idempotent, even after a fence/reset.
            if event['recordingId'] != self.recording_id:
                raise ContractError('RECORDING_MISMATCH')
            if event['kind'] == 'producerReset':
                self.reset(event)
            else:
                if (event['producerInstanceId'], event['clockDomainId']) != (self.producer, self.clock):
                    raise ContractError('SOURCE_MISMATCH')
                if event['sequence'] <= self.sequence or event['atMs'] < self.last_at:
                    raise ContractError('OUT_OF_ORDER')
                if event['kind'] == 'fence':
                    self.fence(event)
                elif event['kind'] == 'gap':
                    # A late, removal-only correction cannot be hidden by Pause.
                    # It must still belong to this recording/producer/clock, and
                    # cannot assert a policy revision that has not happened.
                    if any(event['fences'][key] > value for key, value in self.fences.items()):
                        raise ContractError('FENCE_MISMATCH')
                    self.gap(event)
                else:
                    if event['fences'] != self.fences:
                        raise ContractError('FENCE_MISMATCH')
                    if not self.recording:
                        raise ContractError('NOT_RECORDING')
                    self.observe(event)
                    if event['kind'] in ('focus', 'content', 'admit'):
                        self.last_observation = event['atMs']
                self.sequence, self.last_at = event['sequence'], event['atMs']
            self.seen[event['eventId']] = digest
        except ContractError as error:
            self.rejected.append({'eventId': event.get('eventId', 'invalid'), 'code': error.code})

    def reset(self, event):
        if event['fences'] != self.fences:
            raise ContractError('FENCE_MISMATCH')
        if event['clockDomainId'] in self.used_clocks or event['producerInstanceId'] in self.used_producers:
            raise ContractError('INCARNATION_REUSED')
        # Never subtract a new producer's clock from the previous domain.
        self.close_visit(self.last_observation)
        if self.recording:
            self.gaps.append({'clockDomainId': self.clock, 'atMs': self.last_observation, 'reason': 'producer-restart'})
        self.jobs.clear()
        self.producer, self.clock = event['producerInstanceId'], event['clockDomainId']
        self.used_clocks.add(self.clock)
        self.used_producers.add(self.producer)
        self.sequence, self.last_at = event['sequence'], event['atMs']
        self.last_observation = event['atMs']
        # recording=False remains false: a producer restart cannot undo Pause.

    def fence(self, event):
        expected = deepcopy(self.fences)
        expected['lifecycle'] += 1
        field = {'revoke': 'consent', 'exclude': 'exclusion', 'delete': 'deletion'}.get(event['reason'])
        if field:
            expected[field] += 1
        if event['fences'] != expected:
            raise ContractError('INVALID_FENCE')
        self.close_visit(event['atMs'])
        self.recording = False
        self.fences = expected
        self.jobs.clear()
        if event['reason'] == 'delete':
            self.visits.clear()
            self.gaps.clear()
            self.history_deleted = True
            self.seen.clear()  # Old revisions still fence replay; don't retain payload-derived digests.

    def gap(self, event):
        if self.history_deleted:
            raise ContractError('HISTORY_DELETED')
        cutoff = event['cutoffMs']
        if cutoff > event['atMs']:
            raise ContractError('INVALID_CUTOFF')
        self.active = None
        self.recording = False
        self.jobs.clear()
        retained = []
        for visit in self.visits:
            if visit['clockDomainId'] == self.clock:
                if visit['startMs'] >= cutoff:
                    continue
                if visit['endMs'] is None or visit['endMs'] > cutoff:
                    visit['endMs'] = cutoff
                visit['samples'] = [s for s in visit['samples'] if s['capturedAtMs'] < cutoff]
            retained.append(visit)
        self.visits = retained
        self.gaps.append({'clockDomainId': self.clock, 'fromMs': cutoff, 'toMs': event['atMs'], 'reason': 'observation-gap'})

    def observe(self, event):
        kind = event['kind']
        if kind == 'focus':
            if event['source']['kind'] != 'native':
                raise ContractError('BROWSER_NOT_IN_SCOPE')
            if event['visitId'] in self.used_visits:
                raise ContractError('VISIT_ID_REUSED')
            self.close_visit(event['atMs'])
            self.active = {'visitId': event['visitId'], 'clockDomainId': self.clock,
                           'sourceId': event['source']['sourceId'], 'startMs': event['atMs'],
                           'endMs': None, 'samples': [], '_source': deepcopy(event['source']),
                           '_contentRevision': event['contentRevision'], '_streamGeneration': event['streamGeneration']}
            self.visits.append(self.active)
            self.used_visits.add(event['visitId'])
        elif kind == 'content':
            visit = self.active
            if visit is None or event['visitId'] != visit['visitId']:
                raise ContractError('STALE_IDENTITY')
            before = (visit['_contentRevision'], visit['_streamGeneration'])
            after = (event['contentRevision'], event['streamGeneration'])
            if after == before or any(new < old for new, old in zip(after, before)):
                raise ContractError('STALE_IDENTITY')
            visit['_contentRevision'], visit['_streamGeneration'] = after
        elif kind == 'admit':
            visit = self.active
            if (visit is None or event['visitId'] != visit['visitId'] or event['source'] != visit['_source']
                    or event['contentRevision'] != visit['_contentRevision']
                    or event['streamGeneration'] != visit['_streamGeneration']):
                raise ContractError('STALE_IDENTITY')
            if event['jobId'] in self.used_jobs:
                raise ContractError('JOB_ID_REUSED')
            self.jobs = {key: job for key, job in self.jobs.items()
                         if event['atMs'] - job['capturedAtMs'] <= self.limits['maxJobAgeMs']}
            if len(self.jobs) >= self.limits['maxPendingJobs']:
                raise ContractError('QUEUE_FULL')
            self.jobs[event['jobId']] = {'visit': visit, 'capturedAtMs': event['atMs'],
                                         'contentRevision': event['contentRevision'],
                                         'streamGeneration': event['streamGeneration']}
            self.used_jobs.add(event['jobId'])
        elif kind == 'result':
            job = self.jobs.pop(event['jobId'], None)
            if job is None:
                raise ContractError('UNKNOWN_JOB')
            if event['atMs'] - job['capturedAtMs'] > self.limits['maxJobAgeMs']:
                raise ContractError('JOB_EXPIRED')
            visit = job['visit']
            if visit['endMs'] is not None and job['capturedAtMs'] >= visit['endMs']:
                raise ContractError('CAPTURE_OUTSIDE_VISIT')
            result = event['result']
            if result['status'] == 'value' and len(result['value'].encode('utf-8')) > self.limits['maxValueBytes']:
                raise ContractError('VALUE_TOO_LARGE')
            visit['samples'].append({key: job[key] for key in ('capturedAtMs', 'contentRevision', 'streamGeneration')}
                                    | {'jobId': event['jobId'], 'result': deepcopy(result)})

    def snapshot(self):
        visits = []
        for visit in self.visits:
            public = {key: deepcopy(value) for key, value in visit.items() if not key.startswith('_')}
            public['durationMs'] = None if visit['endMs'] is None else visit['endMs'] - visit['startMs']
            # Completion order is not capture order; preserve historical ordering.
            public['samples'].sort(key=lambda sample: (sample['capturedAtMs'], sample['jobId']))
            validators()[1].validate(public)
            visits.append(public)
        return {'recording': self.recording, 'visits': visits, 'rejected': self.rejected, 'gaps': self.gaps}


def replay(corpus, case):
    if len(case['events']) > 256:
        raise ValueError('Draft fixture event limit exceeded')
    defaults = deepcopy(corpus['wireDefaults']) | case.get('wireDefaults', {})
    trace = DraftTrace(defaults, corpus['limits'] | case.get('limits', {}))
    for event in case['events']:
        trace.accept(expand_event(corpus, case, event))
    return trace.snapshot()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--case', help='Run one named canonical sequence')
    parser.add_argument('--json', action='store_true', help='Print invented outcomes, never a native receipt')
    args = parser.parse_args()
    corpus = load_corpus()
    cases = [case for case in corpus['cases'] if args.case is None or case['name'] == args.case]
    if not cases:
        parser.error('Unknown canonical case')
    report = {'scope': 'draft synthetic conformance; not native acceptance', 'cases': []}
    for case in cases:
        actual = replay(corpus, case)
        if actual != case['expected']:
            print(f"FAIL {case['name']}: canonical expected outcome differs", file=sys.stderr)
            return 1
        report['cases'].append({'name': case['name'], 'outcome': actual})
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(report['scope'])
        for case in report['cases']:
            print(f"PASS {case['name']}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
