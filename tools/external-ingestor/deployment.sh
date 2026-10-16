
bunx esbuild src/index.ts --bundle --platform=node --target=node20 --format=cjs --outfile=dist/index.cjs && \
cd dist && zip -j ingestor.zip index.cjs && cd - && \
AWS_PAGER="" AWS_PROFILE=filepipeline aws lambda update-function-code \
  --region ap-southeast-1 \
  --function-name filepipeline-external-ingestor \
  --zip-file fileb://dist/ingestor.zip && \
AWS_PAGER="" AWS_PROFILE=filepipeline aws lambda wait function-updated \
  --region ap-southeast-1 \
  --function-name filepipeline-external-ingestor && \
AWS_PAGER="" AWS_PROFILE=filepipeline aws lambda update-function-configuration \
  --region ap-southeast-1 \
  --function-name filepipeline-external-ingestor \
  --timeout 60 \
  --memory-size 1024