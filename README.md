# NowPlaying

## 概要

![動作画像](docs/overlay.png)

再生中の音楽等をオーバーレイ表示します。  
Discord の RPC への表示も可能です。  
任意で、再生中の曲を自分のサーバ ([Nowplaying-Server](https://github.com/Alice-river/Nowplaying-Server)) へ送り、月・季節・年ごとの統計を作れます。

## 使い方

### ダウンロード

1. [WebNowPlaying](https://chromewebstore.google.com/detail/webnowplaying/jfakgfcdgpghbbefmdfjkbdlibjgnbli?hl=ja)をブラウザに追加します。

2. [NowPlaying.exe](https://github.com/Alice-river/Nowplaying-Agent/releases/latest/download/NowPlaying.exe) をダウンロードします。

### 設定

**[必須]WebNowPlaying 側の設定**

1. ブラウザ上のWebNowPlaying のアイコンをクリックします。
2. Add custom adapterを押し、ポートに `37250` を指定します。

画面の右上にオーバーレイが出れば、つながっています。

**[任意]NowPlaying 側の設定**

タスクトレイのアイコンをダブルクリックすると、設定画面が開きます。

| 項目 | 内容 |
| --- | --- |
| 透過率 | オーバーレイの背景の濃さ |
| 後ろをぼかす | 背景をすりガラスにします。切ると、後ろの画面がそのまま透けます |
| Discord | Discord への表示の切り替えと、Application ID の入力 |
| サーバへの送信 | 送信のオン・オフと、宛先の指定 ([詳しく](#任意サーバへの送信)) |
| Windows の起動時に自動で起動する | オンにすると、サインインのたびに自動で起動します |

オーバーレイは、ドラッグで好きな位置に動かせます。一時停止から10秒たつと、自動で隠れます。トレイを右クリックすると、一時的に隠す、クリックを通す、位置を右上に戻す、の操作ができます。

### [任意]Spotify(デスクトップアプリ)

Spotify のデスクトップアプリで曲を再生すると、WebNowPlaying を使わずに、再生中の曲を表示できます。Windows の SMTC(メディア転送コントロール)から読み取ります。

- Spotify が起動していて曲の情報があるあいだは、ブラウザの再生より **Spotify を優先** します。Spotify を終了すると、ブラウザの再生に戻ります。
- Spotify の設定で「メディアキーを使用するときにデスクトップのオーバーレイを表示する」をオンにしてください。オフだと、Spotify が情報を出しません。
- 設定画面の「Spotify」で、優先表示をオフにできます。

### [任意]Discord連携

Discord への表示には、ApplicationIDが必要です。

1. [Discord Developer Portal](https://discord.com/developers/applications) を開いて、「New Application」を押す
2. 名前を付けて作成する。
3. 「General Information」にある **Application ID** をコピーする。
4. NowPlaying の設定画面を開いて、「Discord」の欄の Application ID に貼り付ける。

欄の下の「状態」が「接続中」になれば完了です。プロフィールに「（曲名）を再生中」と、アーティスト、カバー、進行バーが出ます。

入力するのは Application ID だけです。トークンやシークレットは必要ありません。入力しないでください。

Discord のデスクトップアプリが起動している必要があります（ブラウザ版では使えません）。NowPlaying を先に起動していても、Discord が起動すれば自動でつながります。

### [任意]サーバへの送信

[Nowplaying-Server](https://github.com/Alice-river/Nowplaying-Server) を用意すると、再生した曲を記録して統計ページを作れます。**初期状態はオフ**で、オンにするまで何も送りません。

1. 設定画面の「サーバへの送信」で、宛先にサーバの IP アドレスを入れて「適用」を押します。
2. 「再生中の曲をサーバへ送る」をオンにします。「状態」が「接続中」になれば完了です。

| 項目 | 内容 |
| --- | --- |
| 送るもの | 曲名、アーティスト、アルバム、カバー画像 (URL、または 600px 以下の JPEG)、再生位置と長さ、取得元 (Spotify、YouTube Music など) |
| 宛先の形 | `192.168.1.10`、`192.168.1.10:9000`、`wss://example.com/np/ws` など。ポートを省くと 8000 |
| 既定の宛先 | `172.30.0.40:8000` (作者の私設ネットワーク内のアドレスです。自分のサーバのアドレスに変えてください) |
| 切り替え | 設定画面、またはトレイの右クリックメニュー。オフにすると、すぐに接続を切ります |

- IP アドレスだけを指定した場合は `ws://` で接続し、**通信は暗号化されません**。VPN などの信頼できる経路で使ってください。
- `wss://` の宛先がクライアント証明書を求める場合は、Windows の証明書ストアから、発行元の名前が設定ファイルの `certIssuer` を含むものを選びます。
- Discord の表示は、この PC の再生が優先です。この PC で何も再生していなくて送信がオンのときは、サーバが持つ状態 (別の PC の再生) を表示します。

## 開発

```powershell
npm ci
```

```powershell
npm test
```

```powershell
npm run dist
```

