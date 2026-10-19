// Smoke test: render the sidebar view against a mini fake DOM (no Obsidian needed).
// Run with: node test/test-view.js
'use strict';

const path = require('path');

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.classes = new Set();
    this.attrs = {};
    this.textContent = '';
    this.value = '';
    this.style = {};
    this.disabled = false;
  }
  _add(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }
  createEl(tag, o) {
    const el = new El(tag);
    if (typeof o === 'string') o = { cls: o };
    if (o) {
      if (o.cls) String(o.cls).split(/\s+/).forEach((c) => c && el.classes.add(c));
      if (o.text !== undefined) el.setText(o.text);
      if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.attrs[k] = String(v);
      if (o.type) el.type = o.type;
      if (o.placeholder) el.attrs.placeholder = o.placeholder;
    }
    return this._add(el);
  }
  createDiv(o) { return this.createEl('div', o); }
  createSpan(o) { return this.createEl('span', o); }
  empty() { this.children = []; }
  addClass(...c) { c.forEach((x) => String(x).split(/\s+/).forEach((y) => y && this.classes.add(y))); }
  removeClass(...c) { c.forEach((x) => this.classes.delete(x)); }
  toggleClass(cls, val) {
    const list = Array.isArray(cls) ? cls : [cls];
    list.forEach((c) => (val ? this.classes.add(c) : this.classes.delete(c)));
  }
  setText(t) {
    if (typeof t !== 'string') throw new Error('setText called with non-string: ' + t);
    this.textContent = String(t);
  }
  set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  querySelector(sel) {
    const all = [];
    const walk = (n) => { n.children.forEach((c) => { all.push(c); walk(c); }); };
    walk(this);
    return all.find((e) => e.tagName === sel.toUpperCase()) || null;
  }
  addEventListener() {}
  getContext() { return { clearRect() {} }; }
}

const obsidianStub = {
  Plugin: class {},
  ItemView: class { constructor(leaf) { this.leaf = leaf; this.contentEl = new El('div'); } },
  PluginSettingTab: class {},
  Setting: class { setName() { return this; } setDesc() { return this; } setHeading() { return this; } addText() { return this; } addTextArea() { return this; } addToggle() { return this; } addDropdown() { return this; } addSlider() { return this; } },
  Notice: class { constructor(msg) { console.log('NOTICE:', msg); } },
  requestUrl: async () => ({ status: 200, json: {} }),
  setIcon: (el, name) => { el.textContent = `{icon:${name}}`; },
  MarkdownView: class {},
  normalizePath: (p) => p,
};

const Module = require('module');
const origLoad = Module._load;
Module._load = function (name, ...rest) {
  if (name === 'obsidian') return obsidianStub;
  return origLoad.call(this, name, ...rest);
};

global.window = { setInterval, clearInterval, setTimeout, clearTimeout };

const manifest = require(path.join(__dirname, '..', 'manifest.json'));
const PluginClass = require(path.join(__dirname, '..', 'main.js'));

const fakePlugin = {
  settings: null,
  manifest,
  async loadData() { return null; }, // defaults only
  async saveData() {},
  registerView(type, factory) { this._factory = factory; },
  addRibbonIcon() {},
  addCommand() {},
  addSettingTab() {},
  async listCachedAudio() { return []; },
  saveDraft() {},
  debouncedSaveSettings() {},
  async saveSettings() {},
};

(async () => {
  const p = new PluginClass();
  Object.assign(p, fakePlugin);
  await PluginClass.prototype.loadSettings.call(p);
  fakePlugin.settings = p.settings;
  await PluginClass.prototype.onload.call(p);

  const view = p._factory({ leaf: true });
  view.plugin = p;
  view.app = {};
  await view.onOpen();

  // assertions
  const dumpText = [];
  const walk = (el) => { dumpText.push(el.className + ' ' + el.textContent); el.children.forEach(walk); };
  walk(view.contentEl);
  const all = dumpText.join('\n');
  const mustContain = ['Start recording', 'Dictionary', 'AI polish prompt', 'Cached recordings', 'viz-prompt-body', 'v' + manifest.version];
  for (const s of mustContain) {
    if (!all.includes(s)) throw new Error(`MISSING in rendered view: ${s}`);
  }
  if (all.includes('[object')) throw new Error('found "[object" in rendered output');
  // dictionary parsing + replacement
  const assert = require('assert');
  const { parseDictionary, applyReplacements } = PluginClass._internals;
  const dict = parseDictionary('# comment\nOnBeat、dayframe\nDAU, WAU\n\nRoyas, 羅亞斯 → Russ\nday frame -> dayframe');
  assert.deepStrictEqual(dict.terms, ['OnBeat', 'dayframe', 'DAU', 'WAU', 'Russ']);
  assert.strictEqual(dict.replacements.length, 3);
  assert.strictEqual(
    applyReplacements('跟 royas 和羅亞斯討論 Royaston 的 Day Frame', dict.replacements),
    '跟 Russ 和Russ討論 Royaston 的 dayframe'
  );
  assert.strictEqual(applyReplacements('a.b $& c', [{ from: 'a.b', to: '$&x' }]), '$&x $& c');

  console.log('✅ smoke test passed — view renders, prompt section present, no [object Object]');
})().catch((e) => {
  console.error('🔴', e.message);
  process.exit(1);
});
