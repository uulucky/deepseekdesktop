'use strict';
/** Conversation column: renders a transcript snapshot into ChatGPT-style message rows. */

const streamEl = () => document.getElementById('stream');
const innerEl = () => document.getElementById('stream-inner');
const MAX_VISIBLE_ITEMS = 240;
const MAX_TEXT_CHARS = 48_000;
const MAX_REASONING_CHARS = 24_000;
const MAX_TOOL_CHARS = 12_000;
const expandedDetails = new Set();
let renderedSession = '';
const imageUrls = new Map();
const imageLoads = new Map();
const questionDrafts = new Map();

/** Only a leading, explicit presentation block is special; code/quoted examples stay intact. */
function splitActionSummary(value, streaming = false) {
  const text = String(value ?? '');
  const start = '<desktop-summary>';
  const end = '</desktop-summary>';
  const trimmed = text.trimStart();
  if (streaming && trimmed && start.startsWith(trimmed)) return { text: '', summary: '', pending: true };
  if (!trimmed.startsWith(start)) return { text, summary: '' };
  const body = trimmed.slice(start.length);
  const close = body.indexOf(end);
  if (close < 0 && (!streaming || body.length > 600)) return { text, summary: '' };
  // Do not flash partial closing delimiters while tokens arrive.
  let summary = close < 0 ? body : body.slice(0, close);
  if (close < 0) {
    for (let size = Math.min(end.length - 1, summary.length); size > 0; size -= 1) {
      if (summary.endsWith(end.slice(0, size))) { summary = summary.slice(0, -size); break; }
    }
  }
  return { text: close < 0 ? '' : body.slice(close + end.length), summary: summary.trim(), pending: close < 0 };
}

function actionSummary(text, placeholder = false) {
  return `<section class="action-summary${placeholder ? ' pending' : ''}" aria-label="行动摘要">`
    + `<div class="action-summary-label">${placeholder ? '正在整理行动摘要' : '行动摘要'}</div>`
    + `<div class="action-summary-text">${esc(displayText(text, 600))}</div></section>`;
}

function isChineseSummary(value) {
  const text = String(value ?? '');
  const hanCount = (text.match(/[\u3400-\u9fff]/gu) ?? []).length;
  const latinWords = (text.match(/[A-Za-z]{2,}/g) ?? []).length;
  return hanCount >= 4 && hanCount >= latinWords * 2;
}

/**
 * Models occasionally ignore the presentation wrapper and emit an English pre-tool preamble.
 * Keep that source text available as a collapsed record, but never let protocol drift remove the
 * Chinese, expanded status the desktop promises. This is deliberately deterministic: it does not
 * make another paid model request and it never guesses at tool results that have not arrived.
 */
function fallbackActionSummary(item, parts) {
  const toolText = parts
    .filter(part => part.kind === 'tool-call')
    .map(part => `${part.name ?? ''} ${part.arguments ?? ''}`)
    .join('\n');
  const laterStep = Number(item?.step ?? 0) > 0;
  if (/(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|lint|build)|pytest|cargo\s+test|go\s+test|\btest\b|\blint\b|\bbuild\b|验证|测试|检查构建/i.test(toolText)) {
    return '进展：相关处理已进入验证阶段。下一步：运行检查并根据结果收尾。';
  }
  if (/apply_patch|write|edit|create|mkdir|copy|move|set-content|add-content|out-file|修改|写入|创建/i.test(toolText)) {
    return '进展：已确认需要调整的内容。下一步：完成修改并验证结果。';
  }
  if (/browser|search|web|curl|wget|invoke-webrequest|https?:|搜索|网页|查询/i.test(toolText)) {
    return '准备：查询并核对相关信息。下一步：依据确认后的结果继续处理。';
  }
  if (/image|video|ffmpeg|media|render|图片|视频|素材|渲染/i.test(toolText)) {
    return '准备：检查素材和项目结构。下一步：根据现状调整内容并验证效果。';
  }
  return laterStep
    ? '进展：已取得上一阶段结果。下一步：继续检查关键内容并完成处理。'
    : '准备：检查相关文件和当前状态。下一步：根据结果定位问题并继续处理。';
}

function detailState(key) {
  const id = JSON.stringify([renderedSession, key]);
  return { attributes: ` data-detail-id="${esc(id)}"`, open: expandedDetails.has(id) };
}

function displayText(value, limit) {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n…（超长内容已折叠，完整记录仍保存在本地对话中）`;
}

/** Render one content part. */
function renderPart(part, key = '') {
  if (!part) return '';
  if (part.kind === 'text') return `<div class="content">${window.Markdown.render(displayText(part.text, MAX_TEXT_CHARS))}</div>`;
  if (part.kind === 'reasoning') {
    return fold('思考原文', '详细记录', `<pre>${esc(displayText(part.text, MAX_REASONING_CHARS))}</pre>`, key);
  }
  if (part.kind === 'tool-call') {
    return fold('调用工具 ' + esc(part.name || ''), esc(part.summary || ''), `<pre>${esc(displayText(part.arguments, MAX_TOOL_CHARS))}</pre>`, key);
  }
  if (part.kind === 'image') {
    const id = part.attachmentId ? esc(part.attachmentId) : '';
    return `<div class="message-attachment image"><div class="message-image-placeholder" data-image-attachment="${id}">图片${part.name ? ' · ' + esc(part.name) : ''}</div></div>`;
  }
  if (part.kind === 'file') {
    const suffix = String(part.name || '文件').split('.').pop().slice(0, 6).toUpperCase();
    return `<div class="message-attachment file"><span class="message-file-icon">${esc(suffix)}</span><span><strong>${esc(part.name || '文件')}</strong>${part.bytes ? `<small>${esc(compact(part.bytes))} bytes</small>` : ''}</span></div>`;
  }
  return '';
}

/** Collapsible card markup (reasoning, tool calls, diffs). */
function fold(title, sub, body, key) {
  const { attributes, open } = detailState(key);
  return (
    `<div class="fold${open ? ' open' : ''}"${attributes}>` +
      `<div class="fold-head" role="button" tabindex="0" aria-expanded="${open}"><svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>` +
      `<span class="fold-title">${title}</span><span class="fold-sub">${sub}</span></div>` +
      `<div class="fold-body">${body}</div>` +
    '</div>'
  );
}

/** A Host waterfall pauses the tool until the user explicitly allows or rejects it. */
function renderApproval(approval) {
  const reason = approval.reason
    ? `<div class="approval-reason">${esc(approval.reason)}</div>`
    : '<div class="approval-reason">该工具需要额外权限，选择后任务才会继续。</div>';
  return (
    `<div class="approval-panel" data-approval-id="${esc(approval.eventId)}">` +
      '<div class="approval-mark">!</div>' +
      '<div class="approval-copy">' +
        '<div class="approval-title">等待你的权限选择</div>' +
        `<div class="approval-tool">${esc(approval.toolName || '工具')} 正在等待，任务尚未结束。</div>` +
        reason +
      '</div>' +
      '<div class="approval-actions">' +
        `<button class="approval-btn reject" data-approval-action="rejected" data-approval-id="${esc(approval.eventId)}">拒绝</button>` +
        `<button class="approval-btn allow" data-approval-action="allowed-once" data-approval-id="${esc(approval.eventId)}">允许本次</button>` +
      '</div>' +
    '</div>'
  );
}

function rememberQuestionDrafts() {
  for (const panel of innerEl()?.querySelectorAll?.('.question-panel') ?? []) {
    const id = panel.getAttribute('data-question-id');
    if (!id) continue;
    questionDrafts.set(id, [...panel.querySelectorAll('.question-group')].map((group) => ({
      selected: [...group.querySelectorAll('[data-question-option]:checked')].map((input) => input.value),
      custom: group.querySelector('[data-question-custom]')?.value ?? '',
      skipped: Boolean(group.querySelector('[data-question-skip]')?.checked),
    })));
  }
  if (questionDrafts.size > 50) questionDrafts.delete(questionDrafts.keys().next().value);
}

function renderQuestion(pending) {
  const drafts = questionDrafts.get(pending.eventId) ?? [];
  const groups = (pending.questions ?? []).map((question, index) => {
    const draft = drafts[index] ?? { selected: [], custom: '', skipped: false };
    const options = (question.options ?? []).map((option) => (
      `<label class="question-option"><input type="${question.multiSelect ? 'checkbox' : 'radio'}" ` +
      `name="question-${esc(pending.eventId)}-${index}" value="${esc(option.label)}" data-question-option ` +
      `${draft.selected.includes(option.label) ? 'checked' : ''}>` +
      `<span><strong>${esc(option.label)}</strong>${option.description ? `<small>${esc(option.description)}</small>` : ''}</span></label>`
    )).join('');
    return `<fieldset class="question-group" data-question-index="${index}">` +
      `<legend>${esc(question.header || `问题 ${index + 1}`)}</legend>` +
      `<div class="question-text">${esc(question.question || '')}</div>` +
      (question.detail ? `<pre class="question-detail">${esc(displayText(question.detail, MAX_TEXT_CHARS))}</pre>` : '') +
      options +
      `<textarea data-question-custom maxlength="4000" placeholder="也可以填写自己的回答">${esc(draft.custom)}</textarea>` +
      `<label class="question-skip"><input type="checkbox" data-question-skip ${draft.skipped ? 'checked' : ''}>暂不回答此题</label>` +
      '</fieldset>';
  }).join('');
  return `<section class="question-panel" data-question-id="${esc(pending.eventId)}" aria-label="等待回答的问题">` +
    '<div class="question-title">DeepSeek 正在等待你的回答</div>' + groups +
    '<div class="question-actions">' +
      `<button class="approval-btn reject" data-question-action="cancel" data-question-id="${esc(pending.eventId)}">取消提问</button>` +
      `<button class="approval-btn allow" data-question-action="answer" data-question-id="${esc(pending.eventId)}">提交回答并继续</button>` +
    '</div></section>';
}

/** Render one transcript item (user / assistant / tool / turn marker). */
function renderItem(item, approvals = [], questions = [], rowKey = '') {
  if (item.kind === 'user') {
    const tags = item.synthetic ? '<span class="tag">系统注入</span>' : '';
    const pending = item.pending ? ' pending' : '';
    const failed = item.failed ? ' failed' : '';
    const body = item.parts?.length
      ? item.parts.map((part) => (part.kind === 'text' ? `<div class="bubble">${esc(displayText(part.text, MAX_TEXT_CHARS))}</div>` : renderPart(part))).join('')
      : `<div class="bubble">${esc(displayText(item.text, MAX_TEXT_CHARS))}</div>`;
    if (item.synthetic) return `<div class="system-context">${fold('运行环境', '系统上下文', body, `${rowKey}:context`)}</div>`;
    return (
      `<div class="msg user${pending}${failed}">` +
        '<div class="msg-avatar">你</div>' +
        `<div class="msg-body"><div class="msg-name">你${tags}${item.failed ? '<span class="tag">发送失败</span>' : ''}</div>${body}</div>` +
      '</div>'
    );
  }

  if (item.kind === 'assistant') {
    const parts = item.parts ?? [];
    const firstText = parts.findIndex(part => part.kind === 'text');
    const text = firstText < 0 ? '' : parts[firstText].text || '';
    const presentation = splitActionSummary(text, item.streaming);
    const hasReasoning = parts.some(part => part.kind === 'reasoning');
    const hasToolCall = parts.some(part => part.kind === 'tool-call');
    const validSummary = presentation.summary && (isChineseSummary(presentation.summary) || !hasToolCall);
    const fallbackSummary = hasToolCall && !validSummary ? fallbackActionSummary(item, parts) : '';
    const summary = validSummary ? actionSummary(presentation.summary)
      : fallbackSummary ? actionSummary(fallbackSummary)
      : (item.streaming && !text && hasReasoning) || presentation.pending
        ? actionSummary('正在分析任务，整理接下来要做的事…', true) : '';
    const unwrappedProgress = hasToolCall
      ? [validSummary ? '' : presentation.summary, presentation.text].filter(Boolean).join('\n').trim()
      : '';
    const body = [
      summary,
      unwrappedProgress
        ? fold('模型进展原文', '详细记录', `<pre>${esc(displayText(unwrappedProgress, MAX_REASONING_CHARS))}</pre>`, `${rowKey}:progress`)
        : '',
      ...parts.map((part, index) => {
        if (index === firstText) {
          if (unwrappedProgress) return '';
          return presentation.text.trim() ? renderPart({ kind: 'text', text: presentation.text }) : '';
        }
        return renderPart(part, `${rowKey}:part:${index}`);
      }),
    ].join('');
    const streamingTag = item.streaming ? '<span class="tag">生成中</span>' : '';
    const interrupted = item.interrupted ? '<span class="tag">已中断</span>' : '';
    const usage = item.usage
      ? `<div class="usage-line">输出 ${compact(item.usage.outputTokens)} tokens · 输入 ${compact((item.usage.inputTokens ?? 0) + (item.usage.cacheReadTokens ?? 0))} tokens</div>`
      : '';
    return (
      '<div class="msg assistant">' +
        '<div class="msg-avatar">D</div>' +
        `<div class="msg-body"><div class="msg-name">DeepSeek${streamingTag}${interrupted}</div>${body || '<div class="content"><p>…</p></div>'}</div>` +
      '</div>' + usage
    );
  }

  if (item.kind === 'tool') {
    const approval = approvals.find((entry) => (
      (entry.callId && entry.callId === item.callId)
      || (!entry.callId && item.running && entry.toolName === item.name)
    ));
    const waitingQuestion = item.running && item.name === 'ask_user_question' && questions.length > 0;
    const status = waitingQuestion ? '等待回答' : approval ? '等待授权' : item.running ? '运行中' : item.isError ? '失败' : item.interrupted ? '已中断' : '完成';
    const cls = item.isError ? 'fold err' : 'fold';
    const sub = esc(item.summary || status);
    const { attributes, open } = detailState(`${rowKey}:tool`);
    return (
      `<div class="${cls}${open ? ' open' : ''}"${attributes} style="margin-left:41px">` +
        `<div class="fold-head" role="button" tabindex="0" aria-expanded="${open}"><svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>` +
        `<span class="fold-title">${esc(item.name || '工具')}</span><span class="fold-sub">${sub}</span>` +
        `<span class="badge ${item.isError || approval || waitingQuestion ? 'warn' : item.running ? '' : 'ok'}" style="margin-left:auto">${status}</span></div>` +
        `<div class="fold-body">${item.arguments ? `<pre>${esc(displayText(item.arguments, MAX_TOOL_CHARS))}</pre>` : ''}${item.output ? `<pre>${esc(displayText(item.output, MAX_TOOL_CHARS))}</pre>` : ''}</div>` +
      '</div>'
    );
  }

  if (item.kind === 'turn-end' && item.reason && item.reason !== 'stop' && item.reason !== 'completed') {
    const reason = ({ complete: '完成', aborted: '已停止', cancelled: '已停止', interrupted: '已中断',
      blocked: '已阻塞', error: '执行失败', 'max-tokens': '已达到输出上限' })[item.reason] ?? String(item.reason);
    return `<div class="usage-line">回合结束：${esc(reason)}${item.error ? ' · ' + esc(item.error) : ''}</div>`;
  }
  return '';
}

/** Empty state with starter suggestions. */
function renderEmpty() {
  const suggestions = [
    { title: '读代码', text: '这个项目是怎么启动的？' },
    { title: '写脚本', text: '帮我写一个批量重命名文件的脚本' },
    { title: '查资料', text: '总结一下 DeepSeek 的缓存计费规则' },
    { title: '改文档', text: '把 README 改写成面向新手的版本' },
  ];
  return (
    '<div class="empty">' +
      '<div class="empty-mark">D</div>' +
      '<h1>今天想做什么？</h1>' +
      '<p>直接描述你的任务。DeepSeek 会读取当前工作目录、运行命令并给出结果，全部在本地完成。</p>' +
      '<div class="suggestions">' +
        suggestions.map((item) => `<button class="suggestion" data-prompt="${esc(item.text)}"><strong>${esc(item.title)}</strong>${esc(item.text)}</button>`).join('') +
      '</div>' +
    '</div>'
  );
}

const ChatView = {
  /** Full re-render of the transcript column from a snapshot. */
  render(transcript) {
    const inner = innerEl();
    if (!inner) return;
    rememberQuestionDrafts();
    const approvals = transcript?.approvals ?? [];
    const questions = transcript?.questions ?? [];
    renderedSession = transcript?.sessionId ?? '';
    if (!transcript || (!(transcript.items ?? []).length && !approvals.length && !questions.length)) {
      inner.innerHTML = renderEmpty();
      return;
    }
    const allItems = transcript.items.filter((item) => item.kind !== 'turn-start');
    const hiddenCount = Math.max(0, allItems.length - MAX_VISIBLE_ITEMS);
    const items = hiddenCount ? allItems.slice(-MAX_VISIBLE_ITEMS) : allItems;
    const historyNotice = hiddenCount
      ? `<div class="history-window-note">为保证长对话稳定，当前显示最近 ${MAX_VISIBLE_ITEMS} 条记录；更早的 ${hiddenCount} 条仍保存在本地。</div>`
      : '';
    inner.innerHTML = historyNotice + items.map((item, index) => renderItem(item, approvals, questions,
      item.callId ?? (item.kind === 'assistant' && item.turn !== undefined
        ? `assistant:${item.turn}:${item.step}` : `${item.kind}:${item.seq ?? index + hiddenCount}`))).join('')
      + approvals.map(renderApproval).join('') + questions.map(renderQuestion).join('');
    this.hydrateImages(renderedSession);
    this.scrollToBottom();
  },

  hydrateImages(sessionId) {
    for (const node of document.querySelectorAll?.('[data-image-attachment]') ?? []) {
      const attachmentId = node.getAttribute('data-image-attachment');
      if (!sessionId || !attachmentId) continue;
      const key = `${sessionId}:${attachmentId}`;
      const install = (url) => {
        if (!node.isConnected || node.querySelector('img')) return;
        const image = document.createElement('img');
        image.src = url;
        image.alt = '对话图片';
        node.textContent = '';
        node.appendChild(image);
      };
      if (imageUrls.has(key)) { install(imageUrls.get(key)); continue; }
      if (!imageLoads.has(key)) {
        imageLoads.set(key, api.sessions.attachment(sessionId, attachmentId).then((result) => {
          const binary = atob(result.data);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
          const url = URL.createObjectURL(new Blob([bytes], { type: result.attachment?.mediaType || 'image/png' }));
          imageUrls.set(key, url);
          while (imageUrls.size > 24) {
            const oldest = imageUrls.keys().next().value;
            URL.revokeObjectURL(imageUrls.get(oldest));
            imageUrls.delete(oldest);
          }
          return url;
        }).catch(() => null).finally(() => imageLoads.delete(key)));
      }
      imageLoads.get(key).then((url) => { if (url) install(url); });
    }
  },

  scrollToBottom() {
    const stream = streamEl();
    if (!stream) return;
    const nearBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 260;
    if (nearBottom) stream.scrollTop = stream.scrollHeight;
  },

  scrollToEnd() {
    const stream = streamEl();
    if (stream) stream.scrollTop = stream.scrollHeight;
  },

  /** Delegated handlers: fold toggles, copy buttons, external links, suggestions. */
  install() {
    document.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target.matches?.('.fold-head')) {
        event.preventDefault();
        event.target.click();
      }
    });
    document.addEventListener('click', (event) => {
      const target = event.target;
      const questionButton = target.closest?.('[data-question-action]');
      if (questionButton) {
        const eventId = questionButton.getAttribute('data-question-id');
        const panel = questionButton.closest('.question-panel');
        const sessionId = state.activeSessionId;
        const cancel = questionButton.getAttribute('data-question-action') === 'cancel';
        const answers = cancel ? null : [...(panel?.querySelectorAll('.question-group') ?? [])].map((group, index) => {
          const question = state.transcript?.questions?.find((item) => item.eventId === eventId)?.questions?.[index];
          const custom = group.querySelector('[data-question-custom]')?.value.trim() ?? '';
          const selected = [...group.querySelectorAll('[data-question-option]:checked')].map((input) => input.value);
          return { id: question?.id, selected: group.querySelector('[data-question-skip]')?.checked ? []
            : custom && !question?.multiSelect ? [] : selected,
          ...(custom && !group.querySelector('[data-question-skip]')?.checked ? { custom } : {}) };
        });
        if (!cancel && answers.some((answer, index) => {
          const skipped = panel.querySelectorAll('[data-question-skip]')[index]?.checked;
          return !skipped && !answer.selected.length && !answer.custom;
        })) { toast('请回答每个问题，或勾选“暂不回答此题”', 'err'); return; }
        const buttons = [...(panel?.querySelectorAll('[data-question-action]') ?? [])];
        buttons.forEach((button) => { button.disabled = true; });
        panel?.classList.add('answering');
        guard(api.sessions.answerQuestion(sessionId, eventId, answers), '提交问题回答')
          .then((result) => {
            if (result) { questionDrafts.delete(eventId); toast(cancel ? '已取消提问' : '已提交回答，任务继续运行', 'ok'); }
            else { buttons.forEach((button) => { button.disabled = false; }); panel?.classList.remove('answering'); }
          });
        return;
      }
      const approvalButton = target.closest?.('[data-approval-action]');
      if (approvalButton) {
        const eventId = approvalButton.getAttribute('data-approval-id');
        const outcome = approvalButton.getAttribute('data-approval-action');
        const panel = approvalButton.closest('.approval-panel');
        const buttons = [...(panel?.querySelectorAll('[data-approval-action]') ?? [])];
        buttons.forEach((button) => { button.disabled = true; });
        panel?.classList.add('answering');
        guard(api.sessions.answerApproval(state.activeSessionId, eventId, outcome), '处理权限请求')
          .then((result) => {
            if (result) toast(outcome === 'allowed-once' ? '已允许，任务继续运行' : '已拒绝该操作', 'ok');
            else {
              buttons.forEach((button) => { button.disabled = false; });
              panel?.classList.remove('answering');
            }
          });
        return;
      }
      const foldHead = target.closest?.('.fold-head');
      if (foldHead) {
        const card = foldHead.parentElement;
        const open = card.classList.toggle('open');
        foldHead.setAttribute('aria-expanded', String(open));
        const key = card.getAttribute('data-detail-id');
        if (key) {
          if (open) expandedDetails.add(key);
          else expandedDetails.delete(key);
          // Bound UI-only state; never store reasoning or tool contents here.
          if (expandedDetails.size > 500) expandedDetails.delete(expandedDetails.values().next().value);
        }
        return;
      }
      const copy = target.closest?.('.md-copy');
      if (copy) {
        api.app.copy(copy.getAttribute('data-copy') ?? '');
        toast('已复制', 'ok');
        return;
      }
      const link = target.closest?.('[data-external]');
      if (link) {
        event.preventDefault();
        api.app.openExternal(link.getAttribute('data-external'));
        return;
      }
      const suggestion = target.closest?.('.suggestion');
      if (suggestion) {
        const input = document.getElementById('input');
        input.value = suggestion.getAttribute('data-prompt') ?? '';
        input.focus();
        window.App?.autoGrow(input);
      }
    });
  },
};

window.ChatView = ChatView;
