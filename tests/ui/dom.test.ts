import assert from 'node:assert/strict';
import test from 'node:test';

// Just enough DOM for the primitives; HTML parsing APIs throw so any use is a failure.
class FakeText {constructor(readonly data: string) {}}
class FakeElement {
  children: (FakeElement | FakeText)[] = [];
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  className = ''; id = ''; htmlFor = ''; type = ''; name = ''; autocomplete = ''; value = '';
  minLength = -1; maxLength = -1; required = false; disabled = false;
  constructor(readonly tagName: string) {}
  get textContent(): string {return this.children.map(child => child instanceof FakeText ? child.data : child.textContent).join('');}
  set textContent(text: string) {this.children = text ? [new FakeText(text)] : [];}
  set innerHTML(_: string) {throw new Error('innerHTML used');}
  insertAdjacentHTML() {throw new Error('insertAdjacentHTML used');}
  append(...nodes: (FakeElement | string)[]) {for (const node of nodes) this.children.push(typeof node === 'string' ? new FakeText(node) : node);}
  setAttribute(name: string, value: string) {this.attributes.set(name, value);}
  getAttribute(name: string) {return this.attributes.get(name) ?? null;}
}
(globalThis as {document?: unknown}).document = {createElement: (tag: string) => new FakeElement(tag)};
const {button, card, setStatus, statusRegion, textField} = await import('../../core/ui/dom.js');
const fake = <T>(node: T) => node as unknown as FakeElement;
const hostile = '<img src=x onerror="alert(1)"> & <b>bold</b>';

test('buttons default to type=button, opt into submit, and expose disabled state', () => {
  const plain = fake(button('Create account'));
  assert.equal(plain.tagName, 'button');
  assert.equal(plain.type, 'button');
  assert.equal(plain.className, 'sp-button');
  assert.equal(plain.dataset.variant, 'secondary');
  assert.equal(plain.disabled, false);
  const submit = fake(button('Sign in', {variant: 'primary', type: 'submit', disabled: true}));
  assert.equal(submit.type, 'submit');
  assert.equal(submit.dataset.variant, 'primary');
  assert.equal(submit.disabled, true);
});

test('text fields tie a visible label and hint to a uniquely identified input', () => {
  const name = textField('Account name', {name: 'name', autocomplete: 'username', required: true, maxLength: 64});
  const password = textField('Password', {name: 'password', type: 'password', autocomplete: 'current-password', minLength: 12, hint: 'At least 12 characters.'});
  const [label, input, hint] = fake(password.root).children as FakeElement[];
  assert.equal(label!.tagName, 'label');
  assert.equal(label!.textContent, 'Password');
  assert.equal(label!.htmlFor, input!.id);
  assert.equal(fake(password.input), input);
  assert.equal(input!.type, 'password');
  assert.equal(input!.className, 'sp-field');
  assert.equal(input!.autocomplete, 'current-password');
  assert.equal(input!.minLength, 12);
  assert.equal(input!.getAttribute('aria-describedby'), hint!.id);
  assert.equal(hint!.textContent, 'At least 12 characters.');
  assert.notEqual(fake(name.input).id, input!.id);
  assert.equal(fake(name.input).type, 'text');
  assert.equal(fake(name.input).required, true);
  assert.equal(fake(name.input).getAttribute('aria-describedby'), null);
});

test('cards name themselves by their heading and keep children in order', () => {
  const body = button('Sync now');
  const root = fake(card('Sync', 'Last synced: never', body));
  const [heading, text, child] = root.children;
  assert.equal(root.tagName, 'section');
  assert.equal(root.getAttribute('aria-labelledby'), (heading as FakeElement).id);
  assert.equal((heading as FakeElement).textContent, 'Sync');
  assert.equal((text as FakeText).data, 'Last synced: never');
  assert.equal(child, fake(body));
  assert.equal(fake(card(undefined, 'Untitled')).getAttribute('aria-labelledby'), null);
});

test('status region announces loading/success politely and errors assertively', () => {
  const region = fake(statusRegion());
  assert.equal(region.getAttribute('role'), 'status');
  assert.equal(region.dataset.state, 'idle');
  assert.equal(region.getAttribute('aria-live'), 'polite');
  setStatus(region as unknown as HTMLElement, 'loading', 'Signing in…');
  assert.deepEqual([region.dataset.state, region.getAttribute('aria-live'), region.textContent], ['loading', 'polite', 'Signing in…']);
  setStatus(region as unknown as HTMLElement, 'error', 'Sign-in failed.');
  assert.deepEqual([region.dataset.state, region.getAttribute('aria-live'), region.textContent], ['error', 'assertive', 'Sign-in failed.']);
  setStatus(region as unknown as HTMLElement, 'success', 'Signed in.');
  assert.equal(region.getAttribute('aria-live'), 'polite');
});

test('user and provider text stays inert text in every primitive', () => {
  const field = textField(hostile, {name: 'x', hint: hostile, value: hostile});
  const nodes = [fake(button(hostile)), fake(card(hostile, hostile)), fake(statusRegion('error', hostile)), fake(field.root)];
  const elements = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(child => child instanceof FakeElement ? elements(child) : [])];
  for (const node of nodes) {
    assert.ok(node.textContent.includes(hostile));
    assert.deepEqual(elements(node).filter(child => ['img', 'b', 'script'].includes(child.tagName)), []);
  }
  assert.equal(fake(field.input).value, hostile);
});
