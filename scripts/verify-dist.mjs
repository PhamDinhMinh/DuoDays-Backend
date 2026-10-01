// Loads the compiled module graph under plain Node ESM (no Vite interop), so broken
// imports – e.g. a named import from a CommonJS package – fail here instead of at deploy.
// Importing does not start the app: AppModule is only a class until NestFactory runs.
try {
  await import('../dist/app.module.js');
  await import('../dist/app.setup.js');
  console.log('dist: module graph loads under Node ESM');
} catch (error) {
  console.error('dist: module graph failed to load\n', error);
  process.exit(1);
}
