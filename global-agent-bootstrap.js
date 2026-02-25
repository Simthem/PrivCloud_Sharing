require('./node_modules/global-agent/bootstrap');

const proxy = process.env.GLOBAL_AGENT_HTTP_PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
if (proxy) {
    process.env.GLOBAL_AGENT_HTTP_PROXY = proxy;
} else {
    console.warn('[global-agent-bootstrap] No valid proxy environment variable detected (GLOBAL_AGENT_HTTP_PROXY, HTTP_PROXY, HTTPS_PROXY). The proxy will not be configured.');
}