(function () {
  async function api(path, opts) {
    const options = opts || {};
    const { headers: extraHeaders, body, ...restOptions } = options;
    const finalHeaders = { ...extraHeaders };
    if (body) {
      finalHeaders["Content-Type"] = "application/json";
    }
    
    try {
      const response = await fetch(path, {
        headers: finalHeaders,
        body,
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
