import { resolvePublicBuildConfig } from './release-tool.mjs';

resolvePublicBuildConfig(process.env);
console.log('[public-build-env] PASS: explicit public release configuration is valid');
