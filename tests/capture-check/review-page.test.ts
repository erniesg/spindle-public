import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReviewPage } from '../../tools/review_page.js';

const review = {
  title: 'Review captured visits',
  summary: 'Open a visit, inspect its text, then save feedback.',
  caveat: 'This walkthrough uses sample data. Mac and Windows runs still need review.',
  capturedAt: '2026-10-23T13:16:00Z', expiresAt: '2026-10-30T16:00:00Z',
  codeVersion: 'd6e05d19f9', viewerVersion: 'review-page/v1',
  recording: 'https://review.example/walkthrough.mp4?signature=sample',
  recordingFallback: 'https://review.example/walkthrough.webm?signature=sample',
  screens: [{ label: 'Desktop screen', url: 'https://review.example/desktop.png' }, { label: 'Phone layout', url: 'https://review.example/phone.png', phone: true }],
  downloads: [{ label: 'Windows · Intel / AMD', url: 'https://review.example/windows.zip' }],
  recordUrl: 'https://review.example/record.json',
};

test('review opens with a playable recording and keeps technical details secondary', () => {
  const html = renderReviewPage(review);
  assert.match(html, /<video[^>]*controls[^>]*playsinline/);
  assert.match(html, /type="video\/mp4"/);
  assert.match(html, /type="video\/webm"/);
  assert.match(html, /data-view="recording" aria-pressed="true"/);
  assert.match(html, /data-view="screen-1"/);
  assert.match(html, /<details><summary>Technical details<\/summary>/);
  assert.ok(!html.includes('<details open'));
  assert.ok(html.includes(review.caveat));
  assert.ok(html.includes('Windows · Intel / AMD'));
});

test('review copy and file links cannot inject markup or script', () => {
  const html = renderReviewPage({ ...review, title: '<script>not code</script>', summary: '</script><img onerror=evil>', downloads: [{ label: '<b>file</b>', url: 'https://review.example/file?name=" onfocus="evil' }] });
  assert.ok(!html.includes('<script>not code</script>'));
  assert.ok(!html.includes('</script><img onerror=evil>'));
  assert.ok(html.includes('&lt;script&gt;not code&lt;/script&gt;'));
  assert.match(html, /referrer" content="no-referrer/);
  assert.match(html, /script-src 'nonce-/);
});

test('review refuses unsafe links or invented capture dates', () => {
  assert.throws(() => renderReviewPage({ ...review, recording: 'javascript:evil()' }), /HTTPS/);
  assert.throws(() => renderReviewPage({ ...review, recordingFallback: 'javascript:evil()' }), /HTTPS/);
  assert.throws(() => renderReviewPage({ ...review, recordUrl: 'https://user:password@review.example/record.json' }), /HTTPS/);
  assert.throws(() => renderReviewPage({ ...review, capturedAt: 'not a date' }), /date/i);
});
