import { SourceOffer, sourceCodeUrl } from './sourceOffer'

export function Home () {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0"/>
        <title></title>
        <link rel="icon" href="/share/static/favicon.ico" type="image/x-icon"/>
        <style dangerouslySetInnerHTML={{
          __html: `
            html, body {
              margin: 0;
              height: 100vh;
              background: #262626;
            }
            body {
              display: flex;
              justify-content: center;
              align-items: center;
            }
            img {
              max-width: 280px;
              height: 280px;
              opacity: 0.3;
            }
            .source-offer {
              position: fixed;
              right: 1rem;
              bottom: 1rem;
              font: 12px system-ui, sans-serif;
            }
            .source-offer a { color: #b7b7b7; }
          `
        }}/>
      </head>
      <body>
        <div class="container">
          <a href={sourceCodeUrl()}>
            <img src="/share/static/images/ipp.svg" alt=""/>
          </a>
        </div>
        <SourceOffer/>
      </body>
    </html>
  )
}
