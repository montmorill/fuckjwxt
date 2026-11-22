// /docs 的 Swagger UI 页面与 OAuth2 回调页。
// 前端资源固定走 cdnjs；回调页逻辑来自 swagger-ui-dist 5.35.1。
export const SWAGGER_UI_VERSION = '5.35.1';

export function renderDocsPage() {
  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>API 文档 · 强智 Gateway</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/${SWAGGER_UI_VERSION}/swagger-ui.css">
<style>
  html { box-sizing: border-box; overflow-y: scroll; }
  *, *::before, *::after { box-sizing: inherit; }
  body { margin: 0; background: #fafafa; }
  .docs-fallback { font-family: system-ui, sans-serif; padding: 2rem; color: #444; line-height: 1.6; }
</style>
</head><body>
<div id="swagger-ui"><div class="docs-fallback">
  正在加载 Swagger UI… 如果长时间为空白，请确认能访问 cdnjs.cloudflare.com，或直接打开 <a href="/openapi.json">/openapi.json</a>。
</div></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/${SWAGGER_UI_VERSION}/swagger-ui-bundle.js" crossorigin></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/${SWAGGER_UI_VERSION}/swagger-ui-standalone-preset.js" crossorigin></script>
<script>
  window.ui = SwaggerUIBundle({
    url: '/openapi.json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    docExpansion: 'list',
    defaultModelsExpandDepth: 1,
    oauth2RedirectUrl: window.location.origin + '/docs/oauth2-redirect.html',
    usePkceWithAuthorizationCodeGrant: true,
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
    plugins: [SwaggerUIBundle.plugins.DownloadUrl],
    layout: 'StandaloneLayout',
  });
  // Swagger UI 初始化时会重置 auth configs；在 spec 加载后持续确保 PKCE 生效，
  // 否则授权码请求不会带 code_challenge。
  const ensurePkce = () => {
    try {
      const cfg = window.ui.getSystem().authSelectors.getConfigs();
      if (!cfg || !cfg.usePkceWithAuthorizationCodeGrant) {
        window.ui.initOAuth({ usePkceWithAuthorizationCodeGrant: true });
      }
    } catch { /* UI 尚未就绪 */ }
  };
  ensurePkce();
  setInterval(ensurePkce, 500);
</script>
</body></html>`;
}

export const oauth2RedirectHtml = `<!doctype html>
<html lang="en-US">
<body>
<script src="oauth2-redirect.js"></script>
</body>
</html>
`;

export const oauth2RedirectJs = `"use strict";function run(){var e,r,t,a=window.opener.swaggerUIRedirectOauth2,o=a.state,n=a.redirectUrl;if((t=(r=/code|token|error/.test(window.location.hash)?window.location.hash.substring(1).replace("?","&"):location.search.substring(1)).split("&")).forEach((function(e,r,t){t[r]='"'+e.replace("=",'":"')+'"'})),e=(r=r?JSON.parse("{"+t.join()+"}",(function(e,r){return""===e?r:decodeURIComponent(r)})):{}).state===o,"accessCode"!==a.auth.schema.get("flow")&&"authorizationCode"!==a.auth.schema.get("flow")&&"authorization_code"!==a.auth.schema.get("flow")||a.auth.code)a.callback({auth:a.auth,token:r,isValid:e,redirectUrl:n});else if(e||a.errCb({authId:a.auth.name,source:"auth",level:"warning",message:"Authorization may be unsafe, passed state was changed in server Passed state wasn't returned from auth server"}),r.code)delete a.state,a.auth.code=r.code,a.callback({auth:a.auth,redirectUrl:n});else{let e;r.error&&(e="["+r.error+"]: "+(r.error_description?r.error_description+". ":"no accessCode received from the server. ")+(r.error_uri?"More info: "+r.error_uri:"")),a.errCb({authId:a.auth.name,source:"auth",level:"error",message:e||"[Authorization failed]: no accessCode received from the server"})}window.close()}"loading"!==document.readyState?run():document.addEventListener("DOMContentLoaded",(function(){run()}));
`;
