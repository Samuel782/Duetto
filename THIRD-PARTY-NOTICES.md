# Third-party software

Duetto's own code is covered by [LICENSE](LICENSE). The packages also contain:

| Component | Licence | Full text in the package |
|---|---|---|
| [ws](https://github.com/websockets/ws) | MIT | Reproduced below |
| [Electron](https://github.com/electron/electron) | MIT | `LICENSE.electron.txt` |
| [Chromium](https://www.chromium.org) and the components it includes | Various, mostly BSD-style | `LICENSES.chromium.html` |
| [FFmpeg](https://ffmpeg.org), built by the Electron project as a separate dynamic library | LGPL 2.1 or later | `LICENSES.chromium.html` |
| [Node.js](https://nodejs.org), included in Electron | MIT and others | `LICENSES.chromium.html` |

Electron is distributed unmodified. The source matching each Electron release, including the FFmpeg revision and
its build configuration, is available from the [Electron repository](https://github.com/electron/electron).
Exact versions are listed in the SBOM generated with `npm run sbom`.
Duetto's licence does not limit the rights that these licences give you on their components.

## ws

Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
Copyright (c) 2013 Arnout Kazemier and contributors
Copyright (c) 2016 Luigi Pinca and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
