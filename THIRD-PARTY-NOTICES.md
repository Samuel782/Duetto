# Third-party software

Duetto's own code is covered by [LICENSE](LICENSE). The packages also contain:

| Component | Licence | Full text in the package |
|---|---|---|
| Rust libraries, including [Tauri](https://tauri.app) | MIT, Apache 2.0, BSD, ISC, Zlib, Unicode, MPL 2.0 and others | `LICENSES.rust.txt` |
| [Rust standard library](https://github.com/rust-lang/rust) | MIT or Apache 2.0 | `LICENSES.rust.txt` has the text of both licences |
| Microsoft Edge WebView2 loader (Windows only) | [Microsoft WebView2 SDK licence](https://www.nuget.org/packages/Microsoft.Web.WebView2/) | Reproduced below |

Pages are shown by the web engine already in the operating system (WebKit on Mac, WebView2 on Windows), which is not
included. `LICENSES.rust.txt` lists every library with its version, its licence and the address of its source code,
which is used unmodified. The same list is in the SBOM published with each release.
Duetto's licence does not limit the rights that these licences give you on their components.

## Microsoft Edge WebView2 loader

Copyright (C) Microsoft Corporation. All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
following conditions are met:

* Redistributions of source code must retain the above copyright notice, this list of conditions and the following
  disclaimer.
* Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following
  disclaimer in the documentation and/or other materials provided with the distribution.
* The name of Microsoft Corporation, or the names of its contributors may not be used to endorse or promote products
  derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
