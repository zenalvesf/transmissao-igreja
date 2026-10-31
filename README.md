# Transmissão Igreja

Duas ferramentas em um só programa, feitas para rodar no PC de transmissão da igreja junto com o OBS:

1. **Câmeras pelo celular, sem instalar app.** O celular abre um link no navegador e o vídeo chega ao OBS como fonte de navegador, via WebRTC, direto pela rede local. Reconecta sozinho quando o Wi‑Fi oscila. Funciona com iPhone e Android ao mesmo tempo.
2. **Mesa de produção para voluntários.** Uma página web (no PC ou num tablet) com botões grandes para trocar de cena, iniciar/encerrar a transmissão, roteiro do culto, legendas (nome do pregador, versículo, aviso rolante, título, contagem regressiva), controle dos celulares e mixer de áudio.

## O que você precisa

- Windows com **OBS Studio 28 ou mais novo** (o servidor WebSocket já vem embutido).
- Celulares e PC no **mesmo Wi‑Fi** da igreja.
- Node.js só se for rodar no modo manual ou gerar o instalador.

## Instalação pelo programa (recomendado)

1. Pegue o instalador `TransmissaoIgreja-Setup-x.y.z.exe` (pasta `dist` depois de gerar, veja abaixo) e rode no PC de transmissão. Não precisa instalar Node.js nem nada mais.
2. O programa abre com a mesa numa janela própria e fica com um ícone na **bandeja** (perto do relógio). Fechar a janela não desliga nada: as câmeras e o OBS continuam conectados. Para desligar de verdade: ícone da bandeja → **Sair**.
3. Na aba **Config** da mesa ele mostra o OBS deste computador:
   - **OBS fechado** → botão **Abrir OBS** (ele habilita o WebSocket sozinho antes de abrir).
   - **WebSocket desligado** → botão **Habilitar WebSocket do OBS** (feche e abra o OBS depois).
   - A **senha** é lida do próprio OBS: não é preciso copiar nada. Só configure manualmente se o OBS estiver em outro computador.
4. Aba **Câmeras** → **Configurar OBS automaticamente** (cria as cenas e fontes, como descrito abaixo).
5. Opcional: ícone da bandeja → **Iniciar junto com o Windows**, assim o programa já está pronto quando o PC liga.

Os dados (roteiro, modelos, configuração, log) ficam em `%APPDATA%	ransmissao-igreja`; o ícone da bandeja tem um atalho para essa pasta.

### Gerar o instalador (quem desenvolve)

Precisa de Node.js LTS. Na pasta do projeto:

```
npm install
npm run dist
```

O instalador sai em `dist/TransmissaoIgreja-Setup-<versão>.exe`. Para testar sem gerar o instalador: `npm run app`.

**Atualização automática:** quando o projeto estiver num repositório do GitHub, troque o campo `build.publish` em `package.json` já aponta para github.com/zenalvesf/transmissao-igreja; publique as versões como *Releases* (`npx electron-builder --win --publish always` com a variável `GH_TOKEN`). O programa instalado passa a baixar a versão nova sozinho e instala ao sair.

## Instalação sem o programa (modo manual, com Node.js)

1. Copie a pasta `transmissao-igreja` para o PC de transmissão (ex.: `C:\transmissao-igreja`).
2. Dê dois cliques em **`iniciar.bat`**. Na primeira vez ele instala as dependências e gera um certificado para o HTTPS dos celulares.
3. No OBS: **Ferramentas → Configurações do servidor WebSocket** → marque **Habilitar servidor WebSocket** → clique em **Mostrar detalhes de conexão** e copie a senha.
4. Abra a mesa em **http://localhost:8080/mesa** → aba **Config** → cole a senha → **Salvar e reconectar**. O selo "OBS" no topo fica verde.
5. Ainda na mesa, aba **Câmeras** → **Configurar OBS automaticamente**. Isso cria no OBS:
   - uma cena `Cam – Celular 1` e `Cam – Celular 2` com a fonte de navegador de cada celular;
   - uma cena `Overlay` com as legendas, já adicionada por cima de todas as suas cenas.
   Depois é só arrastar as fontes dos celulares para dentro das suas cenas já existentes, se preferir.

> Se preferir adicionar manualmente: **Fonte de navegador** com largura 1920, altura 1080 e a URL que aparece na aba Câmeras (ex.: `http://localhost:8080/view/Celular%201`). Deixe **desmarcado** "Desligar fonte quando não visível", senão a câmera reconecta a cada troca de cena.

## No dia do culto

1. Abra o **Transmissao Igreja** (atalho na área de trabalho) ou, no modo manual, o `iniciar.bat`. Abra o OBS pela aba Config, se ainda não estiver aberto.
2. **Celulares:** leia o QR code da página inicial (ou da aba Câmeras da mesa). O navegador vai avisar que o certificado não é confiável: toque em **Avançado → Continuar** (no iPhone: **Mostrar detalhes → Visitar este site**). Isso acontece só na primeira vez em cada aparelho. Escolha o nome da câmera, confira a qualidade e toque em **Iniciar câmera**. Deixe o celular no tripé carregando; a tela fica ligada sozinha.
3. **Mesa:** abra http://localhost:8080/mesa no PC, ou `http://IP-DO-PC:8080/mesa` em um tablet.
4. Siga o **Roteiro**: o botão **Próximo** troca a cena e dispara a legenda configurada em cada item. Teclas **1 a 9** trocam cenas, **Espaço** avança o roteiro.

### Tally (luz de "no ar")
Quando a cena no ar contém a fonte de um celular, a tela desse celular ganha uma borda vermelha e o aviso **NO AR**. Isso usa o nome da câmera: a fonte no OBS precisa conter o nome (ex.: `Celular 1 (celular)`), que é como a configuração automática já cria.

## Dicas para o PC antigo

- No celular use **720p / 30 fps / H264**. 1080p só se o PC aguentar.
- No OBS: **Configurações → Saída → codificador**. Se houver placa NVIDIA use **NVENC**, se for Intel use **QuickSync**; só use x264 em `veryfast` se não houver outra opção. Saída 1280×720 a 30 fps, bitrate 2500–4000 kbps.
- Em **Configurações → Vídeo**, resolução de saída 1280×720 reduz muito a carga.
- Fontes de navegador consomem CPU. Mantenha só as necessárias e desmarque "Desligar fonte quando não visível" para evitar reconexões.

## YouTube + Instagram ao mesmo tempo

O OBS nativo transmite para um destino só. Para YouTube e Instagram juntos, as opções mais usadas:

- **Plugin "Multiple RTMP outputs"** (obs-multi-rtmp): grátis, adiciona um painel no OBS para enviar o mesmo vídeo para mais de um servidor RTMP. Instagram em 16:9 fica com barras pretas.
- **Plugin "Aitum Vertical"**: cria uma tela 9:16 separada dentro do OBS, ideal para o Instagram, usada junto com o Multi‑RTMP.
- **Serviço de restream** (Restream.io, Streamlabs): você envia uma vez e eles reenviam. Mais simples, mas depende de assinatura para vários destinos.

Para o Instagram pelo OBS é preciso uma **conta profissional** e pegar a chave RTMP em *Instagram → Criar → Transmissão ao vivo → Software de transmissão*, no computador. A chave muda a cada live.

## Holyrics

O Holyrics roda em outro PC só para o telão. Para a transmissão, o mais simples é apontar uma das webcams para o telão ou usar o **versículo** e o **título** da mesa, que ficam bem na tela do YouTube. Se quiserem que a letra do Holyrics apareça na live, o caminho é a saída NDI do Holyrics com o plugin **obs-ndi** no OBS; posso integrar isso depois.

## Pastas e arquivos

```
transmissao-igreja/
  app/main.js      aplicativo de área de trabalho (janela, bandeja, autostart, atualização)
  build/           ícone e script do instalador
  iniciar.bat      modo manual: inicia só o servidor com Node.js
  server.js        servidor: páginas, sinalização WebRTC, conexão com o OBS
  obs-local.js     acha o OBS instalado, lê a senha do WebSocket, abre o OBS
  config.json      portas, senha do OBS, nomes das câmeras (gerado na primeira execução)
  data/            roteiro.json e presets.json de exemplo (o programa copia para %APPDATA%)
  certs/           certificado HTTPS gerado automaticamente (modo manual)
  public/
    cam.html/js    página do celular
    view.html/js   fonte de navegador do OBS (uma por celular)
    overlay.html   legendas, versículo, aviso, título e contagem
    mesa.html/js   mesa de produção
```

## Páginas e opções

| Endereço | Para que serve |
|---|---|
| `http://localhost:8080/` | página inicial com QR codes e endereços |
| `http://localhost:8080/mesa` | mesa de produção |
| `https://IP:8443/cam` | celular como câmera (tem que ser https) |
| `http://localhost:8080/view/NOME` | fonte do OBS. Opções: `?fit=contain` (sem cortar), `?audio=1` (com áudio do celular), `?nosignal=black` (tela preta quando cai; o padrão congela o último quadro), `?debug=1` (mostra estatísticas) |
| `http://localhost:8080/overlay` | overlay de legendas. Opções: `?accent=ff9900` (cor da igreja), `?font=Georgia` |

## Problemas comuns

- **O celular diz que precisa de https.** Use o QR code, que já aponta para o endereço https. Se o IP do PC mudou, feche e abra o `iniciar.bat` de novo e apague a pasta `certs` para gerar um certificado com o IP novo.
- **O OBS fica vermelho na mesa.** Na aba Config veja o que ela diz sobre o OBS: se estiver fechado, use **Abrir OBS**; se o WebSocket estiver desligado, **Habilitar WebSocket do OBS** e reabra o OBS. Se mudou a senha no OBS, salve-a em "Configurar manualmente".
- **O Windows perguntou sobre o firewall.** Permita em redes **privadas**; sem isso os celulares não alcançam o PC.
- **A imagem no OBS congela.** Na aba Câmeras clique em **Reiniciar vídeo** no celular correspondente. Se cair muito, aproxime o roteador ou use 540p.
- **Wi‑Fi com "isolamento de clientes" (comum em roteadores de visitante)** impede celular e PC de se verem. Use a rede principal.
- **Dois celulares com o mesmo nome.** O último que entrar substitui o anterior. Dê nomes diferentes na aba Config.
