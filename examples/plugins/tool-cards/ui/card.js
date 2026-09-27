// The Issue card renderer. PiUI sends the tool activity as plain data; this
// page only ever sets textContent, so nothing from the tool becomes markup.
const panel = window.piuiPanel;
const title = document.getElementById('title');
const status = document.getElementById('status');
const fields = document.getElementById('fields');
const raw = document.getElementById('raw');
const note = document.getElementById('note');

const STATUS = { streaming: 'Running…', complete: 'Done', failed: 'Failed', interrupted: 'Stopped' };

/** "Arguments: title: Broken link, priority: normal" → [["title", "Broken link"], ["priority", "normal"]]. */
function parseArguments(text) {
  const body = text.replace(/^Arguments:\s*/i, '');
  const pairs = body.split(/,\s*(?=[A-Za-z_][\w-]*:\s)/u).map((part) => {
    const index = part.indexOf(':');
    return index > 0 ? [part.slice(0, index).trim(), part.slice(index + 1).trim()] : null;
  });
  return pairs.every(Boolean) && pairs.length > 0 ? pairs : null;
}

function show(activity) {
  title.textContent = activity.title || activity.toolName;
  status.textContent = STATUS[activity.status] ?? activity.status;
  status.dataset.status = activity.status;
  const pairs = parseArguments(activity.text);
  fields.replaceChildren();
  if (pairs) {
    for (const [name, value] of pairs) {
      const term = document.createElement('dt');
      term.textContent = name;
      const detail = document.createElement('dd');
      detail.textContent = value;
      fields.append(term, detail);
    }
  }
  raw.hidden = pairs !== null;
  raw.textContent = pairs ? '' : activity.text;
  note.hidden = !activity.truncated;
}

panel.ready.then((init) => {
  if (init.renderer) show(init.renderer.activity);
  panel.autoResize();
});
panel.on('activity', show);
