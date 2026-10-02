// Minimal document.modelContext with the current API shape: registerTool(tool, {signal}),
// getTools() (inputSchema serialized as a JSON string), executeTool(tool, jsonString),
// and declarative <form toolname> tools executed through a submit event with respondWith.
(() => {
  if (document.modelContext) return;
  const tools = new Map();
  const fire = () => { try { window.dispatchEvent(new Event('toolchange')); } catch (_) {} };
  function formTools() {
    return [...document.querySelectorAll('form[toolname]')].map((form) => {
      const props = {};
      const required = [];
      for (const el of form.querySelectorAll('input[name],select[name],textarea[name]')) {
        props[el.name] = { type: 'string', description: el.getAttribute('toolparamdescription') || el.name };
        required.push(el.name);
      }
      return { name: form.getAttribute('toolname'), description: form.getAttribute('tooldescription') || '', form,
        inputSchema: JSON.stringify({ type: 'object', properties: props, required }) };
    });
  }
  const setValue = (el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  class ModelContext extends EventTarget {
    registerTool(tool, options) {
      tools.set(tool.name, tool);
      const signal = options && options.signal;
      if (signal) signal.addEventListener('abort', () => { if (tools.get(tool.name) === tool) { tools.delete(tool.name); fire(); } }, { once: true });
      fire();
    }
    unregisterTool(name) { tools.delete(name); fire(); }
    async getTools() {
      const list = [...tools.values()].map((t) => ({ name: t.name, description: t.description || '', origin: location.origin,
        window, inputSchema: JSON.stringify(t.inputSchema || { type: 'object', properties: {} }) }));
      return list.concat(formTools().map((f) => ({ name: f.name, description: f.description, origin: location.origin, window, inputSchema: f.inputSchema })));
    }
    async executeTool(registered, input) {
      if (typeof registered === 'string') throw new TypeError("The provided value is not of type 'RegisteredTool'");
      const args = typeof input === 'string' ? JSON.parse(input || '{}') : (input || {});
      const tool = tools.get(registered.name);
      if (tool) return tool.execute(args);
      const decl = formTools().find((f) => f.name === registered.name);
      if (!decl) throw new Error('No tool named ' + registered.name);
      for (const [k, v] of Object.entries(args)) {
        const el = decl.form.querySelector(`[name="${k}"]`);
        if (el) setValue(el, v);
      }
      await new Promise((r) => setTimeout(r, 50)); // let React commit the controlled inputs
      return new Promise((resolve) => {
        const ev = new Event('submit', { bubbles: true, cancelable: true });
        ev.agentInvoked = true;
        ev.respondWith = (v) => Promise.resolve(v).then(resolve);
        decl.form.dispatchEvent(ev);
        setTimeout(() => resolve({ note: 'form submitted without respondWith' }), 2000);
      });
    }
  }
  Object.defineProperty(document, 'modelContext', { value: new ModelContext(), configurable: true });
})();
