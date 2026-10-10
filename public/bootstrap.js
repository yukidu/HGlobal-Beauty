(() => {
  const nativeFetch = window.fetch.bind(window);

  window.fetch = (input, init = {}) => {
    const requestUrl = typeof input === 'string' ? input : String(input?.url || '');
    const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));

    if (
      requestUrl.startsWith('/api/') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(method) &&
      typeof init.body === 'string' &&
      !headers.has('Content-Type')
    ) {
      const body = init.body.trim();
      if (body.startsWith('{') || body.startsWith('[')) headers.set('Content-Type', 'application/json');
    }

    return nativeFetch(input, { ...init, headers });
  };
})();
