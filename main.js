/*
 * Voice Input ZH
 * Voice recording → OpenAI transcription (forced Traditional Chinese) → optional LLM polish (custom prompt)
 * Audio is cached to the vault first, so a failed transcription can be retried without re-recording.
 */
'use strict';

const {
  Plugin,
  ItemView,
  PluginSettingTab,
  Setting,
  Notice,
  requestUrl,
  setIcon,
  MarkdownView,
  normalizePath,
} = require('obsidian');

const VIEW_TYPE = 'voice-input-zh-view';

const DEFAULT_SETTINGS = {
  apiKey: '',
  transcriptionModel: 'gpt-4o-transcribe',
  transcriptionPrompt:
    '以下是一段繁體中文（台灣）的口述內容，可能夾雜英文技術詞彙與產品名稱，請以繁體中文輸出。',
  enablePostProcess: true,
  postProcessModel: 'gpt-4o-mini',
  postProcessPrompt:
    '你是語音轉文字的後處理助手。請把使用者提供的逐字稿整理成通順的繁體中文（台灣用語）：\n' +
    '1. 一律輸出繁體中文，絕對不可出現簡體字。\n' +
    '2. 加上正確的標點符號與分段。\n' +
    '3. 移除口頭贅字與語助詞（嗯、呃、就是說、然後然後）。\n' +
    '4. 修正明顯的同音錯字；英文專有名詞維持原文。\n' +
    '5. 不要增刪內容或改變語意，只做整理。\n' +
    '只輸出整理後的文字，不要加任何說明或前後綴。',
  cacheFolder: '_voice-input-cache',
  keepAudioAfterSuccess: false,
  maxRecordingMinutes: 15,
  draftTranscript: '',
  promptCollapsed: false,
};

/* ---------- helpers ---------- */

// errors from requestUrl / adapters aren't always Error instances; never let an object reach the UI
function errText(e) {
  if (e == null) return 'Unknown error';
  if (typeof e === 'string') return e;
  if (typeof e.message === 'string') return e.message;
  try {
    return JSON.stringify(e).slice(0, 300);
  } catch (_) {
    return String(e);
  }
}

function timestampName() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `rec-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.webm`;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatClock(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function buildMultipart(parts) {
  const boundary = '----VoiceInputZh' + Math.random().toString(36).slice(2);
  const enc = new TextEncoder();
  const chunks = [];
  for (const part of parts) {
    chunks.push(enc.encode(`--${boundary}\r\n`));
    if (part.filename) {
      chunks.push(
        enc.encode(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.type}\r\n\r\n`
        )
      );
      chunks.push(new Uint8Array(part.data));
    } else {
      chunks.push(enc.encode(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}`));
    }
    chunks.push(enc.encode('\r\n'));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.length;
  }
  return { boundary, body: body.buffer };
}

/* ---------- OpenAI API ---------- */

async function transcribeAudio(settings, audioBuffer) {
  if (!settings.apiKey) throw new Error('No OpenAI API key set (add it in plugin settings)');
  const parts = [
    { name: 'model', value: settings.transcriptionModel },
    { name: 'language', value: 'zh' },
    { name: 'response_format', value: 'json' },
  ];
  if (settings.transcriptionPrompt.trim()) {
    parts.push({ name: 'prompt', value: settings.transcriptionPrompt.trim() });
  }
  parts.push({ name: 'file', filename: 'audio.webm', type: 'audio/webm', data: audioBuffer });

  const { boundary, body } = buildMultipart(parts);
  const res = await requestUrl({
    url: 'https://api.openai.com/v1/audio/transcriptions',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
    throw: false,
  });
  if (res.status >= 300) {
    const msg = res.json && res.json.error ? errText(res.json.error) : `HTTP ${res.status}`;
    throw new Error(`Transcription failed: ${msg}`);
  }
  return (res.json.text || '').trim();
}

async function postProcessText(settings, text) {
  const res = await requestUrl({
    url: 'https://api.openai.com/v1/chat/completions',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: settings.postProcessModel,
      temperature: 0.2,
      messages: [
        { role: 'system', content: settings.postProcessPrompt },
        { role: 'user', content: text },
      ],
    }),
    throw: false,
  });
  if (res.status >= 300) {
    const msg = res.json && res.json.error ? errText(res.json.error) : `HTTP ${res.status}`;
    throw new Error(`AI polish failed: ${msg}`);
  }
  return res.json.choices[0].message.content.trim();
}

/* ---------- sidebar view ---------- */

class VoiceInputView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.state = 'idle'; // idle | recording | transcribing | polishing | error
    this.mediaRecorder = null;
    this.mediaStream = null;
    this.audioCtx = null;
    this.analyser = null;
    this.rafId = null;
    this.timerId = null;
    this.recordStartedAt = 0;
    this.chunks = [];
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return 'Voice input';
  }
  getIcon() {
    return 'mic';
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('viz-root');

    // header
    const header = root.createDiv({ cls: 'viz-header' });
    const title = header.createDiv({ cls: 'viz-title', text: 'Voice input' });
    title.createSpan({ cls: 'viz-version', text: 'v' + this.plugin.manifest.version });
    const gear = header.createDiv({ cls: 'viz-gear clickable-icon', attr: { 'aria-label': 'Plugin settings' } });
    setIcon(gear, 'settings');
    gear.onclick = () => {
      this.app.setting.open();
      this.app.setting.openTabById('voice-input-zh');
    };

    // recording card
    const card = root.createDiv({ cls: 'viz-card' });
    this.recordBtn = card.createEl('button', { cls: 'viz-record-btn' });
    this.recordBtnIcon = this.recordBtn.createDiv({ cls: 'viz-record-icon' });
    setIcon(this.recordBtnIcon, 'mic');
    this.recordBtnLabel = this.recordBtn.createDiv({ cls: 'viz-record-label', text: 'Start recording' });
    this.recordBtn.onclick = () => this.toggleRecording();

    this.meterCanvas = card.createEl('canvas', { cls: 'viz-meter' });
    this.timerEl = card.createDiv({ cls: 'viz-timer', text: '00:00' });

    const statusRow = card.createDiv({ cls: 'viz-status' });
    this.statusDot = statusRow.createDiv({ cls: 'viz-status-dot' });
    this.statusText = statusRow.createDiv({ cls: 'viz-status-text', text: 'Idle' });

    // transcript
    this.textarea = root.createEl('textarea', {
      cls: 'viz-transcript',
      attr: { placeholder: 'Transcription appears here. You can edit it directly…' },
    });
    this.textarea.value = this.plugin.settings.draftTranscript || '';
    this.textarea.addEventListener('input', () => this.plugin.saveDraft(this.textarea.value));

    // action buttons
    const actions = root.createDiv({ cls: 'viz-actions' });
    this.makeActionBtn(actions, 'text-cursor-input', 'Insert at cursor', true, () => this.insertAtCursor());
    this.makeActionBtn(actions, 'list-end', 'Append to note', false, () => this.appendToEnd());
    this.makeActionBtn(actions, 'copy', 'Copy', false, () => this.copyText());
    this.makeActionBtn(actions, 'eraser', 'Clear', false, () => this.clearText());

    // AI polish prompt (editable in-panel)
    this.buildPromptSection(root);

    // cached recordings
    const pendingSection = root.createDiv({ cls: 'viz-pending' });
    const pendingHeader = pendingSection.createDiv({ cls: 'viz-pending-header' });
    pendingHeader.createSpan({ text: 'Cached recordings' });
    this.pendingCount = pendingHeader.createSpan({ cls: 'viz-pending-count', text: '' });
    this.pendingList = pendingSection.createDiv({ cls: 'viz-pending-list' });

    await this.refreshPendingList();
    this.setState('idle');
  }

  buildPromptSection(root) {
    const section = root.createDiv({ cls: 'viz-prompt' });
    const header = section.createDiv({ cls: 'viz-prompt-header' });

    this.promptChevron = header.createDiv({ cls: 'viz-prompt-chevron' });
    setIcon(this.promptChevron, 'chevron-down');
    header.createSpan({ cls: 'viz-prompt-title', text: 'AI polish prompt' });

    // enable/disable toggle (Obsidian native style)
    this.promptToggle = header.createDiv({
      cls: 'checkbox-container viz-prompt-toggle',
      attr: { 'aria-label': 'Enable AI polish' },
    });
    this.promptToggle.createEl('input', { type: 'checkbox' });
    this.promptToggle.onclick = async (e) => {
      e.stopPropagation();
      this.plugin.settings.enablePostProcess = !this.plugin.settings.enablePostProcess;
      await this.plugin.saveSettings();
      this.syncPromptUI();
    };

    this.promptBody = section.createDiv({ cls: 'viz-prompt-body' });
    this.promptTextarea = this.promptBody.createEl('textarea', {
      cls: 'viz-prompt-text',
      attr: { placeholder: 'Instructions for the LLM that polishes the raw transcript…', rows: '8' },
    });
    this.promptTextarea.value = this.plugin.settings.postProcessPrompt;
    this.promptTextarea.addEventListener('input', () => {
      this.plugin.settings.postProcessPrompt = this.promptTextarea.value;
      this.plugin.debouncedSaveSettings();
    });

    const footer = this.promptBody.createDiv({ cls: 'viz-prompt-footer' });
    footer.createSpan({ cls: 'viz-prompt-hint', text: 'Saved automatically. Runs on the transcript before it lands above.' });
    const resetBtn = footer.createEl('button', { cls: 'viz-mini-btn', attr: { 'aria-label': 'Reset to default prompt' } });
    setIcon(resetBtn, 'rotate-ccw');
    resetBtn.onclick = async () => {
      this.plugin.settings.postProcessPrompt = DEFAULT_SETTINGS.postProcessPrompt;
      this.promptTextarea.value = DEFAULT_SETTINGS.postProcessPrompt;
      await this.plugin.saveSettings();
      new Notice('Prompt reset to default.');
    };

    header.onclick = async (e) => {
      if (e.target instanceof HTMLElement && e.target.closest('.viz-prompt-toggle')) return;
      this.plugin.settings.promptCollapsed = !this.plugin.settings.promptCollapsed;
      await this.plugin.saveSettings();
      this.syncPromptUI();
    };

    this.syncPromptUI();
  }

  syncPromptUI() {
    const s = this.plugin.settings;
    this.promptToggle.toggleClass('is-enabled', !!s.enablePostProcess);
    const input = this.promptToggle.querySelector('input');
    if (input) input.checked = !!s.enablePostProcess;
    this.promptBody.toggleClass('is-hidden', !!s.promptCollapsed);
    this.promptChevron.toggleClass('is-collapsed', !!s.promptCollapsed);
    this.promptTextarea.toggleClass('is-disabled', !s.enablePostProcess);
  }

  makeActionBtn(parent, icon, label, primary, onClick) {
    const btn = parent.createEl('button', { cls: 'viz-action-btn' + (primary ? ' mod-cta' : '') });
    const ic = btn.createDiv({ cls: 'viz-action-icon' });
    setIcon(ic, icon);
    btn.createSpan({ text: label });
    btn.onclick = onClick;
    return btn;
  }

  setState(state, message) {
    this.state = state;
    const map = {
      idle: { text: 'Idle', cls: 'is-idle' },
      recording: { text: 'Recording…', cls: 'is-recording' },
      transcribing: { text: 'Transcribing…', cls: 'is-busy' },
      polishing: { text: 'Polishing with AI…', cls: 'is-busy' },
      error: { text: message || 'Something went wrong', cls: 'is-error' },
    };
    const info = map[state] || map.idle;
    this.statusText.setText(message || info.text);
    this.statusDot.className = 'viz-status-dot ' + info.cls;

    const recording = state === 'recording';
    const busy = state === 'transcribing' || state === 'polishing';
    this.recordBtn.toggleClass('is-recording', recording);
    this.recordBtn.disabled = busy;
    this.recordBtnLabel.setText(recording ? 'Stop & transcribe' : busy ? 'Working…' : 'Start recording');
    setIcon(this.recordBtnIcon, recording ? 'square' : 'mic');
  }

  /* ----- recording ----- */

  async toggleRecording() {
    if (this.state === 'recording') {
      this.stopRecording();
      return;
    }
    if (this.state === 'transcribing' || this.state === 'polishing') return;
    try {
      await this.startRecording();
    } catch (e) {
      console.error('[voice-input-zh]', e);
      this.setState('error', 'Microphone unavailable: ' + errText(e));
      new Notice('Could not access the microphone. Check the macOS microphone permission for Obsidian.');
    }
  }

  async startRecording() {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    this.mediaRecorder = new MediaRecorder(this.mediaStream, { mimeType: mime });
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.mediaRecorder.onstop = () => this.handleRecordingStopped();
    this.mediaRecorder.start(1000);

    // level meter
    this.audioCtx = new AudioContext();
    const source = this.audioCtx.createMediaStreamSource(this.mediaStream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 256;
    source.connect(this.analyser);
    this.drawMeter();

    // timer + cap
    this.recordStartedAt = Date.now();
    const maxSec = this.plugin.settings.maxRecordingMinutes * 60;
    this.timerId = window.setInterval(() => {
      const elapsed = (Date.now() - this.recordStartedAt) / 1000;
      this.timerEl.setText(`${formatClock(elapsed)} / ${formatClock(maxSec)}`);
      if (elapsed >= maxSec) {
        new Notice('Recording limit reached — stopping and transcribing.');
        this.stopRecording();
      }
    }, 250);

    this.setState('recording');
  }

  stopRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
  }

  cleanupRecordingResources() {
    if (this.timerId) {
      window.clearInterval(this.timerId);
      this.timerId = null;
    }
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
      this.analyser = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    this.clearMeter();
  }

  async handleRecordingStopped() {
    this.cleanupRecordingResources();
    const blob = new Blob(this.chunks, { type: 'audio/webm' });
    this.chunks = [];
    if (blob.size < 2000) {
      this.setState('idle');
      new Notice('Recording too short — skipped.');
      return;
    }

    // save audio to the vault first, so a failed transcription can be retried
    let filePath = null;
    try {
      const buffer = await blob.arrayBuffer();
      filePath = await this.plugin.saveAudioToCache(buffer);
      await this.refreshPendingList();
      await this.runTranscription(filePath, buffer);
    } catch (e) {
      console.error('[voice-input-zh]', e);
      this.setState('error', errText(e));
      new Notice(errText(e) + (filePath ? '\nAudio kept in "Cached recordings" — retry from there.' : ''), 8000);
      await this.refreshPendingList();
    }
  }

  /* ----- transcription (shared by new recordings and retries) ----- */

  async runTranscription(filePath, audioBuffer) {
    const settings = this.plugin.settings;
    this.setState('transcribing');
    let text = await transcribeAudio(settings, audioBuffer);

    if (settings.enablePostProcess && text) {
      this.setState('polishing');
      try {
        text = await postProcessText(settings, text);
      } catch (e) {
        // a failed polish should not lose the raw transcript
        console.error('[voice-input-zh]', e);
        new Notice(errText(e) + ' — giving you the raw transcript instead.', 6000);
      }
    }

    this.appendTranscript(text);
    if (!settings.keepAudioAfterSuccess && filePath) {
      await this.plugin.deleteAudio(filePath);
    }
    await this.refreshPendingList();
    this.setState('idle');
    new Notice('Transcription done ✅');
  }

  async retryFile(filePath) {
    if (this.state === 'recording' || this.state === 'transcribing' || this.state === 'polishing') return;
    try {
      const buffer = await this.app.vault.adapter.readBinary(filePath);
      await this.runTranscription(filePath, buffer);
    } catch (e) {
      console.error('[voice-input-zh]', e);
      this.setState('error', errText(e));
      new Notice(errText(e), 8000);
    }
  }

  appendTranscript(text) {
    if (!text) return;
    const current = this.textarea.value.trim();
    this.textarea.value = current ? current + '\n\n' + text : text;
    this.plugin.saveDraft(this.textarea.value);
  }

  /* ----- level meter ----- */

  drawMeter() {
    const canvas = this.meterCanvas;
    const ctx = canvas.getContext('2d');
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    const accent = getComputedStyle(document.body).getPropertyValue('--interactive-accent').trim() || '#7c3aed';

    const draw = () => {
      if (!this.analyser) return;
      this.rafId = requestAnimationFrame(draw);
      this.analyser.getByteFrequencyData(data);
      const w = (canvas.width = canvas.offsetWidth * window.devicePixelRatio);
      const h = (canvas.height = canvas.offsetHeight * window.devicePixelRatio);
      ctx.clearRect(0, 0, w, h);
      const bars = 28;
      const gap = w * 0.012;
      const barW = (w - gap * (bars - 1)) / bars;
      ctx.fillStyle = accent;
      for (let i = 0; i < bars; i++) {
        const v = data[Math.floor((i / bars) * data.length * 0.7)] / 255;
        const barH = Math.max(h * 0.06, v * h);
        ctx.beginPath();
        const x = i * (barW + gap);
        const y = (h - barH) / 2;
        ctx.roundRect(x, y, barW, barH, barW / 2);
        ctx.fill();
      }
    };
    draw();
  }

  clearMeter() {
    const ctx = this.meterCanvas.getContext('2d');
    ctx.clearRect(0, 0, this.meterCanvas.width, this.meterCanvas.height);
    this.timerEl.setText('00:00');
  }

  /* ----- cached recordings list ----- */

  async refreshPendingList() {
    const files = await this.plugin.listCachedAudio();
    this.pendingList.empty();
    this.pendingCount.setText(files.length ? `(${files.length})` : '');
    this.pendingList.toggleClass('is-empty', files.length === 0);
    if (!files.length) {
      this.pendingList.createDiv({ cls: 'viz-pending-empty', text: 'No pending recordings' });
      return;
    }
    for (const f of files) {
      const row = this.pendingList.createDiv({ cls: 'viz-pending-item' });
      const info = row.createDiv({ cls: 'viz-pending-info' });
      info.createDiv({ cls: 'viz-pending-name', text: f.name });
      info.createDiv({ cls: 'viz-pending-size', text: formatBytes(f.size) });
      const retryBtn = row.createEl('button', { cls: 'viz-mini-btn', attr: { 'aria-label': 'Retry transcription' } });
      setIcon(retryBtn, 'refresh-cw');
      retryBtn.onclick = () => this.retryFile(f.path);
      const delBtn = row.createEl('button', { cls: 'viz-mini-btn viz-mini-danger', attr: { 'aria-label': 'Delete' } });
      setIcon(delBtn, 'trash-2');
      delBtn.onclick = async () => {
        await this.plugin.deleteAudio(f.path);
        await this.refreshPendingList();
      };
    }
  }

  /* ----- text actions ----- */

  getTargetMarkdownView() {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) return active;
    let found = null;
    this.app.workspace.iterateRootLeaves((leaf) => {
      if (!found && leaf.view instanceof MarkdownView) found = leaf.view;
    });
    const recent = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
    if (recent && recent.view instanceof MarkdownView) return recent.view;
    return found;
  }

  insertAtCursor() {
    const text = this.textarea.value.trim();
    if (!text) return new Notice('Nothing to insert.');
    const view = this.getTargetMarkdownView();
    if (!view) return new Notice('No open note found.');
    view.editor.replaceSelection(text);
    new Notice('Inserted at cursor.');
  }

  appendToEnd() {
    const text = this.textarea.value.trim();
    if (!text) return new Notice('Nothing to insert.');
    const view = this.getTargetMarkdownView();
    if (!view) return new Notice('No open note found.');
    const editor = view.editor;
    const lastLine = editor.lastLine();
    const lastCh = editor.getLine(lastLine).length;
    const prefix = editor.getValue().trim().length ? '\n\n' : '';
    editor.replaceRange(prefix + text, { line: lastLine, ch: lastCh });
    new Notice('Appended to note.');
  }

  async copyText() {
    const text = this.textarea.value.trim();
    if (!text) return new Notice('Nothing to copy.');
    await navigator.clipboard.writeText(text);
    new Notice('Copied.');
  }

  clearText() {
    this.textarea.value = '';
    this.plugin.saveDraft('');
  }

  async onClose() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.onstop = null;
      this.mediaRecorder.stop();
    }
    this.cleanupRecordingResources();
  }
}

/* ---------- settings tab ---------- */

class VoiceInputSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('OpenAI API key')
      .setDesc('Used for transcription and AI polish. Stored locally on this machine only.')
      .addText((t) => {
        t.setPlaceholder('sk-...')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (v) => {
            this.plugin.settings.apiKey = v.trim();
            await this.plugin.saveSettings();
          });
        t.inputEl.type = 'password';
        t.inputEl.style.width = '100%';
      });

    new Setting(containerEl).setName('Transcription').setHeading();

    new Setting(containerEl)
      .setName('Transcription model')
      .addDropdown((d) =>
        d
          .addOption('gpt-4o-transcribe', 'GPT-4o transcribe (most accurate)')
          .addOption('gpt-4o-mini-transcribe', 'GPT-4o mini transcribe (fast, cheap)')
          .addOption('whisper-1', 'Whisper-1')
          .setValue(this.plugin.settings.transcriptionModel)
          .onChange(async (v) => {
            this.plugin.settings.transcriptionModel = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Transcription prompt')
      .setDesc(
        'Context hint sent to the transcription model: tells it to output Traditional Chinese and how to spell recurring names. Add your usual jargon and product names here.'
      )
      .addTextArea((t) => {
        t.setValue(this.plugin.settings.transcriptionPrompt).onChange(async (v) => {
          this.plugin.settings.transcriptionPrompt = v;
          await this.plugin.saveSettings();
        });
        t.inputEl.rows = 3;
        t.inputEl.style.width = '100%';
      });

    new Setting(containerEl).setName('AI polish').setHeading();

    new Setting(containerEl)
      .setName('Enable AI polish')
      .setDesc(
        'After transcription, run the transcript through an LLM with the prompt below (guarantees Traditional Chinese, punctuation, filler removal). Also editable directly in the panel.'
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enablePostProcess).onChange(async (v) => {
          this.plugin.settings.enablePostProcess = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Polish model')
      .addText((t) =>
        t.setValue(this.plugin.settings.postProcessModel).onChange(async (v) => {
          this.plugin.settings.postProcessModel = v.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Polish prompt')
      .setDesc('Instructions applied to the transcript before the LLM. The same prompt is shown and editable in the panel.')
      .addTextArea((t) => {
        t.setValue(this.plugin.settings.postProcessPrompt).onChange(async (v) => {
          this.plugin.settings.postProcessPrompt = v;
          await this.plugin.saveSettings();
        });
        t.inputEl.rows = 9;
        t.inputEl.style.width = '100%';
      });

    new Setting(containerEl).setName('Audio cache').setHeading();

    new Setting(containerEl)
      .setName('Cache folder')
      .setDesc('Recordings are saved to this vault folder first. Deleted after a successful transcription by default; kept for retry on failure.')
      .addText((t) =>
        t.setValue(this.plugin.settings.cacheFolder).onChange(async (v) => {
          this.plugin.settings.cacheFolder = normalizePath(v.trim() || DEFAULT_SETTINGS.cacheFolder);
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Keep audio after successful transcription')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.keepAudioAfterSuccess).onChange(async (v) => {
          this.plugin.settings.keepAudioAfterSuccess = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Max recording length (minutes)')
      .addSlider((s) =>
        s
          .setLimits(1, 30, 1)
          .setValue(this.plugin.settings.maxRecordingMinutes)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.maxRecordingMinutes = v;
            await this.plugin.saveSettings();
          })
      );
  }
}

/* ---------- plugin ---------- */

class VoiceInputZhPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new VoiceInputView(leaf, this));

    this.addRibbonIcon('mic', 'Voice input (zh-TW)', () => this.activateView());

    this.addCommand({
      id: 'open-view',
      name: 'Open voice input panel',
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: 'toggle-recording',
      name: 'Start/stop recording',
      callback: async () => {
        const view = await this.activateView();
        if (view) view.toggleRecording();
      },
    });

    this.addSettingTab(new VoiceInputSettingTab(this.app, this));
  }

  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    return leaf.view instanceof VoiceInputView ? leaf.view : null;
  }

  /* ----- audio cache ----- */

  async ensureCacheFolder() {
    const folder = normalizePath(this.settings.cacheFolder);
    if (!(await this.app.vault.adapter.exists(folder))) {
      await this.app.vault.adapter.mkdir(folder);
    }
    return folder;
  }

  async saveAudioToCache(arrayBuffer) {
    const folder = await this.ensureCacheFolder();
    const path = normalizePath(`${folder}/${timestampName()}`);
    await this.app.vault.adapter.writeBinary(path, arrayBuffer);
    return path;
  }

  async listCachedAudio() {
    const folder = normalizePath(this.settings.cacheFolder);
    if (!(await this.app.vault.adapter.exists(folder))) return [];
    const listing = await this.app.vault.adapter.list(folder);
    const files = [];
    for (const path of listing.files) {
      if (!path.endsWith('.webm')) continue;
      let size = 0;
      const stat = await this.app.vault.adapter.stat(path);
      if (stat) size = stat.size;
      files.push({ path, name: path.split('/').pop(), size });
    }
    files.sort((a, b) => b.name.localeCompare(a.name));
    return files;
  }

  async deleteAudio(path) {
    try {
      if (await this.app.vault.adapter.exists(path)) {
        await this.app.vault.adapter.remove(path);
      }
    } catch (e) {
      console.error('[voice-input-zh] failed to delete audio', e);
    }
  }

  /* ----- settings ----- */

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  debouncedSaveSettings() {
    if (this._saveTimer) window.clearTimeout(this._saveTimer);
    this._saveTimer = window.setTimeout(() => this.saveSettings(), 800);
  }

  saveDraft(text) {
    this.settings.draftTranscript = text;
    this.debouncedSaveSettings();
  }

  onunload() {}
}

module.exports = VoiceInputZhPlugin;
