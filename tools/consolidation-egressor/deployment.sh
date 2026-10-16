bunx esbuild src/index.ts --bundle --platform=node --target=node20 --format=cjs --outfile=dist/index.cjs && \
cd dist && zip -j egressor.zip index.cjs && cd - && \
AWS_PAGER="" AWS_PROFILE=filepipeline aws lambda update-function-code \
  --region ap-southeast-1 \
  --function-name filepipeline-consolidation-egressor \
  --zip-file fileb://dist/egressor.zip && \
AWS_PAGER="" AWS_PROFILE=filepipeline aws lambda wait function-updated \
  --region ap-southeast-1 \
  --function-name filepipeline-consolidation-egressor && \
AWS_PAGER="" AWS_PROFILE=filepipeline aws lambda update-function-configuration \
  --region ap-southeast-1 \
  --function-name filepipeline-consolidation-egressor \
  --timeout 29
