(function () {
  async function api(path, opts) {
    const options = opts || {};
    try {
      const response = await fetch(path, {
        headers: { "Content-Type": "application/json" },
        ...options,
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
