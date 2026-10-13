import { h } from './util.js';

/**
 * Render chat text as DOM nodes (never innerHTML): ```code blocks```,
 * `inline code`, **bold**, links, and @mentions.
 */
export function renderText(text, myName) {
  const frag = document.createDocumentFragment();
  const parts = text.split(/```(?:[a-z0-9+-]*\n)?([\s\S]*?)```/gi);
  parts.forEach((part, i) => {
    if (i % 2 === 1) frag.append(h('pre', { class: 'code-block' }, h('code', {}, part.replace(/\n$/, ''))));
    else renderInline(part, frag, myName);
  });
  return frag;
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])|(@[\w.-]+)/g;

function renderInline(text, parent, myName) {
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const [tok] = m;
    if (m[1]) parent.append(h('code', { class: 'inline-code' }, tok.slice(1, -1)));
    else if (m[2]) parent.append(h('strong', {}, tok.slice(2, -2)));
    else if (m[3]) parent.append(h('a', { href: tok, target: '_blank', rel: 'noopener noreferrer' }, tok));
    else if (m[4]) {
      const isMe = myName && tok.slice(1).toLowerCase() === myName.toLowerCase().replace(/\s+/g, '');
      parent.append(h('span', { class: `mention${isMe ? ' me' : ''}` }, tok));
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

export function mentionsMe(text, myName) {
  if (!myName) return false;
  const handle = `@${myName.toLowerCase().replace(/\s+/g, '')}`;
  return text.toLowerCase().split(/[\s,.:;!?]+/).includes(handle) || /(^|\s)@(everyone|here)\b/i.test(text);
}
