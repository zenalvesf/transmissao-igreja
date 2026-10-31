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

**Atualização automática:** o campo `build.publish` em `package.json` aponta para github.com/zenalvesf/transmissao-igreja. Publique cada versão como *Release* nesse repositório (ver abaixo). O programa instalado baixa a versão nova sozinho e instala ao sair. Para isso o repositório precisa ser **público**.

Para publicar uma versão: aumente `version` em `package.json`, rode `npm run dist` e depois `gh release create v<versão> dist/TransmissaoIgreja-Setup-<versão>.exe dist/*.blockmap dist/latest.yml`.

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
3. **Destinos:** se usar YouTube + Instagram, confira na aba Destinos se os dois estão ligados e com a chave do dia (a do Instagram muda a cada live).
4. **Holyrics:** na aba Holyrics, confira se está "conectado" e se **Mostrar a letra na live** está ligado. A letra do telão entra sozinha na transmissão.
5. **Mesa:** abra http://localhost:8080/mesa no PC, ou `http://IP-DO-PC:8080/mesa` em um tablet.
6. Siga o **Roteiro**: o botão **Próximo** troca a cena e dispara a legenda configurada em cada item. Teclas **1 a 9** trocam cenas, **Espaço** avança o roteiro, **R** salva um replay.
7. **Multiview:** o botão no alto da mesa abre uma janela com o programa e todas as cenas ao vivo, para um segundo monitor ou TV. Clicar numa cena corta para ela.

### Tally (luz de "no ar")
Quando a cena no ar contém a fonte de um celular, a tela desse celular ganha uma borda vermelha e o aviso **NO AR**. Isso usa o nome da câmera: a fonte no OBS precisa conter o nome (ex.: `Celular 1 (celular)`), que é como a configuração automática já cria.

## Dicas para o PC antigo

- No celular use **720p / 30 fps / H264**. 1080p só se o PC aguentar.
- No OBS: **Configurações → Saída → codificador**. Se houver placa NVIDIA use **NVENC**, se for Intel use **QuickSync**; só use x264 em `veryfast` se não houver outra opção. Saída 1280×720 a 30 fps, bitrate 2500–4000 kbps.
- Em **Configurações → Vídeo**, resolução de saída 1280×720 reduz muito a carga.
- Fontes de navegador consomem CPU. Mantenha só as necessárias e desmarque "Desligar fonte quando não visível" para evitar reconexões.

## YouTube + Instagram ao mesmo tempo (multidestino)

O programa tem um **multidestino** embutido: o OBS transmite uma única vez para ele, e ele reenvia para cada destino. Se um destino cair, só ele reconecta; os outros continuam. Tudo fica na aba **Destinos** da mesa.

1. Aba **Destinos** → **Apontar o OBS para este programa**. Isso configura o OBS (Configurações → Transmissão) para enviar para `rtmp://127.0.0.1:1935/live`, chave `obs`. Só precisa fazer uma vez.
2. **YouTube**: ligue o destino e cole a chave de transmissão do YouTube Studio. O servidor padrão já está preenchido. Formato "Mesmo vídeo do OBS": sem recodificar, não pesa no PC.
3. **Instagram**: no computador, Instagram → Criar → **Transmissão ao vivo** → *Software de transmissão*. Copie o **URL do servidor** (começa com `rtmps://`) e a **chave** para o destino Instagram. Formato "Recorte vertical 9:16": o programa recorta uma faixa vertical do vídeo e manda em 720×1280 (ou 1080×1920). Ajuste a **posição do recorte** com a barra (por exemplo, para enquadrar o púlpito). A chave do Instagram muda a cada live.
4. **Salvar destinos** e, no topo, **Iniciar transmissão**. Os selos no cabeçalho (YouTube ●, Instagram ●) mostram cada destino no ar.

Dá para adicionar outros destinos (Facebook, site da igreja etc.) com **+ Adicionar destino**. Chaves de transmissão ficam salvas no PC e nunca aparecem na tela.

**Recorte vertical e o PC antigo.** O recorte precisa recodificar o vídeo. O programa usa a placa de vídeo quando existe (NVIDIA NVENC, Intel QuickSync ou AMD AMF, testados nessa ordem e escolhidos sozinho) e só cai no processador (libx264) se não houver nenhuma. Se o PC sofrer, use 720×1280 e 2000 kbps, ou mude o Instagram para "Mesmo vídeo do OBS" (fica 16:9 com barras, sem recodificar).

**Como funciona por dentro:** servidor RTMP local (node-media-server) na porta 1935 + um processo ffmpeg por destino, com reinício automático e espera crescente (3 s, 6 s… até 30 s) quando cai. O ffmpeg vem dentro do instalador.

## Letra do Holyrics na live

O Holyrics roda em outro PC, só para o telão. O programa lê pela rede o slide que o Holyrics está mostrando e coloca o texto na transmissão, por cima da imagem, com o mesmo visual das outras legendas (faixa escura, caixa ou só texto com sombra). Não precisa de NDI nem de plugin no OBS.

**No PC do Holyrics (uma vez só):**

1. **Menu arquivo → Configurações → API Server.** Ative para a **rede local**. Anote o IP e a porta (normalmente 8091).
2. Em **gerenciar permissões**, crie um token e marque a permissão **GetCurrentPresentation** (é a única que o programa usa). Copie o token.
3. Se o Windows do PC do Holyrics perguntar sobre firewall, permita na rede privada.

**No PC da transmissão:** aba **Holyrics** da mesa → IP, porta e token → **Testar conexão** → **Salvar e conectar**. Pronto: quando o Holyrics mostra uma música ou texto, a letra aparece na live; tela preta, papel de parede ou nada em exibição tiram a letra da live.

- **Mostrar a letra na live** liga e desliga a letra sem desconectar. Também dá para colocar no roteiro ("Letra do Holyrics: mostrar/ocultar"), por exemplo ligar no Louvor e desligar na Pregação.
- **Aparência:** embaixo ou em cima, três tamanhos, faixa de ponta a ponta / caixa / só sombra, maiúsculas e nome da música. Quando a legenda inferior (nome do pregador) está na tela, a letra sobe um pouco para não cobrir.
- **Versículos:** a API do Holyrics não entrega o texto do versículo, só a referência. Para versículo na live, use o **Versículo** da aba Legendas (ou aponte uma câmera para o telão).
- Os dois PCs precisam estar na mesma rede. O programa consulta o Holyrics várias vezes por segundo, mas só baixa dados quando o slide muda.

## Replay instantâneo

Serve para rever um momento (batismo, apresentação das crianças, testemunho) segundos depois de acontecer. Usa o **buffer de replay** do próprio OBS: ele guarda os últimos 30 segundos do programa na memória.

- Aba **Replay** da mesa. Com o OBS conectado o buffer liga sozinho (dá para desligar isso).
- **Salvar os últimos 30 s** (ou tecla **R** em qualquer aba) grava o trecho num arquivo, na pasta de gravação do OBS.
- **Exibir o último replay** coloca o trecho no ar, na cena "Replay", e volta sozinho para a cena anterior quando termina. **Voltar para o programa** corta antes. Velocidade: normal, 75%, câmera lenta 50% ou 25%.
- Os replays salvos no culto ficam listados para exibir de novo.

**Se a mesa disser "O replay não está ativado nas configurações do OBS":** feche o OBS e clique em **Ativar o replay no OBS e abrir o OBS**. O programa liga o buffer no perfil do OBS (Configurações → Saída → Buffer de replay) com a duração escolhida e abre o OBS de novo. Para mudar a duração depois, troque na mesa e repita esse botão, ou mude direto no OBS.

## Multiview

`http://localhost:8080/multiview` mostra o programa em grande e todas as cenas em miniaturas ao vivo, com borda vermelha na que está no ar. Clique ou teclas **1 a 9** cortam. Abra em tela cheia (F11) num segundo monitor ou numa TV da sala técnica. As miniaturas vêm do próprio OBS; com muitas cenas num PC fraco, feche o multiview durante a transmissão.

## Pastas e arquivos

```
transmissao-igreja/
  app/main.js      aplicativo de área de trabalho (janela, bandeja, autostart, atualização)
  build/           ícone e script do instalador
  iniciar.bat      modo manual: inicia só o servidor com Node.js
  server.js        servidor: páginas, sinalização WebRTC, conexão com o OBS
  obs-local.js     acha o OBS instalado, lê a senha do WebSocket, abre o OBS
  relay.js         multidestino: recebe do OBS (RTMP) e reenvia para YouTube/Instagram
  holyrics.js      lê pela API do Holyrics o slide em exibição e manda para o overlay
  replay.js        replay instantâneo com o buffer de replay do OBS
  config.json      portas, senha do OBS, nomes das câmeras (gerado na primeira execução)
  data/            roteiro.json e presets.json de exemplo (o programa copia para %APPDATA%)
  certs/           certificado HTTPS gerado automaticamente (modo manual)
  public/
    cam.html/js    página do celular
    view.html/js   fonte de navegador do OBS (uma por celular)
    overlay.html   legendas, versículo, aviso, título, contagem e letra do Holyrics
    mesa.html/js   mesa de produção
    multiview.html programa + todas as cenas ao vivo (segundo monitor)
```

## Páginas e opções

| Endereço | Para que serve |
|---|---|
| `http://localhost:8080/` | página inicial com QR codes e endereços |
| `http://localhost:8080/mesa` | mesa de produção |
| `https://IP:8443/cam` | celular como câmera (tem que ser https) |
| `http://localhost:8080/view/NOME` | fonte do OBS. Opções: `?fit=contain` (sem cortar), `?audio=1` (com áudio do celular), `?nosignal=black` (tela preta quando cai; o padrão congela o último quadro), `?debug=1` (mostra estatísticas) |
| `http://localhost:8080/overlay` | overlay de legendas. Opções: `?accent=ff9900` (cor da igreja), `?font=Georgia` |
| `http://localhost:8080/multiview` | multiview: programa + cenas ao vivo, clique para cortar |

## Problemas comuns

- **O celular diz que precisa de https.** Use o QR code, que já aponta para o endereço https. Se o IP do PC mudou, feche e abra o `iniciar.bat` de novo e apague a pasta `certs` para gerar um certificado com o IP novo.
- **"Salvar replay" falha.** O buffer precisa estar ligado (selo verde "buffer ligado" na aba Replay). Se o OBS não tem o buffer de replay ativado nas configurações, use o botão **Ativar o replay no OBS** com o OBS fechado.
- **O Holyrics fica em "erro" na mesa.** A mensagem ao lado diz o motivo: "não aceitou a conexão" é API Server desligado ou IP errado; "token inválido" é token digitado errado ou sem a permissão GetCurrentPresentation; "tempo esgotado" costuma ser firewall no PC do Holyrics ou os PCs em redes diferentes.
- **O OBS fica vermelho na mesa.** Na aba Config veja o que ela diz sobre o OBS: se estiver fechado, use **Abrir OBS**; se o WebSocket estiver desligado, **Habilitar WebSocket do OBS** e reabra o OBS. Se mudou a senha no OBS, salve-a em "Configurar manualmente".
- **O Windows perguntou sobre o firewall.** Permita em redes **privadas**; sem isso os celulares não alcançam o PC.
- **A imagem no OBS congela.** Na aba Câmeras clique em **Reiniciar vídeo** no celular correspondente. Se cair muito, aproxime o roteador ou use 540p.
- **Um destino fica em "reconectando".** Clique em **Ver log** no destino para ver a mensagem do ffmpeg: normalmente é chave errada ou vencida (Instagram) ou internet sem banda para dois envios. O outro destino não é afetado.
- **Wi‑Fi com "isolamento de clientes" (comum em roteadores de visitante)** impede celular e PC de se verem. Use a rede principal.
- **Dois celulares com o mesmo nome.** O último que entrar substitui o anterior. Dê nomes diferentes na aba Config.
