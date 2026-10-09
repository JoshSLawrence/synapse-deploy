# Third-party notices

## Azure/Synapse-workspace-deployment

synapse-deploy was derived from, and inspired by,
Azure/Synapse-workspace-deployment
(<https://github.com/Azure/Synapse-workspace-deployment>), a GitHub Action
that deploys Azure Synapse workspace artifacts. Portions of the following
files are derived from it and keep its copyright header:

- `src/defaults.ts`
- `src/kinds.ts`
- `src/template.ts`
- `test/fixtures/templates/basic/` (`template.json`, `parameters.json` and
  `legacy.json`), which derive from a test helper written by Microsoft.
  JSON cannot carry a header, so this entry stands in for one.

The rest of the code was written for this project. The upstream license
follows.

The bundle in `dist/index.js` also contains third-party packages. Their
licenses and copyright notices are in `dist/licenses.txt`, which the build
regenerates.

```text
MIT License

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE
```
