(function () {
  async function api(path, opts) {
    const options = opts || {};
    try {
      const response = await fetch(path, {
        headers: { "Content-Type": "application/json" },
        ...options,
      });
      return response.json();
    } catch {
      return null;
    }
  }

  window.AcbApi = {
    api,
  };
})();
