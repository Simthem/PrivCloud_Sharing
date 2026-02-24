require('./node_modules/global-agent/bootstrap'); // chemin relatif local

if (!process.env.GLOBAL_AGENT_HTTP_PROXY) {
    process.env.GLOBAL_AGENT_HTTP_PROXY = 'http://10.142.10.10:3128';
}