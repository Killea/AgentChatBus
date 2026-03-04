(function () {
  async function api(path, opts) {
    const options = opts || {};
    const { headers: extraHeaders, ...restOptions } = options;
    try {
      const response = await fetch(path, {
        headers: { "Content-Type": "application/json", ...extraHeaders },
        ...restOptions,
      });
      if (!response.ok) {
        console.warn(`[API] ${options.method || 'GET'} ${path} → HTTP ${response.status}`);
      }
      return await response.json();
    } catch (err) {
      console.warn(`[API] ${options.method || 'GET'} ${path} → network error:`, err);
      return null;
    }
  }

  window.AcbApi = {
    api,
  };
})();
