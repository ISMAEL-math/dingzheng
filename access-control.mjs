export function sessionToken(req){return /(?:^|;\s*)dingzheng_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1]||''}
export function sameOrigin(req,origin){return req.headers.host===new URL(origin).host&&(!req.headers.origin||req.headers.origin===origin)&&req.headers['sec-fetch-site']!=='cross-site'}
export function cookie(token,secure,clear=false){return `dingzheng_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear?0:604800}${secure?'; Secure':''}`}
