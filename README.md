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

1. Abra o **Transmissao Igreja** (atalho na área de trabalho) ou, no modo manual, o `iniciar.bat`. O OBS abre sozinho, escondido na bandeja do Windows: ninguém precisa mexer nele.
2. **Celulares:** leia o QR code da página inicial (ou da aba Câmeras da mesa). O navegador vai avisar que o certificado não é confiável: toque em **Avançado → Continuar** (no iPhone: **Mostrar detalhes → Visitar este site**). Isso acontece só na primeira vez em cada aparelho. Escolha o nome da câmera, confira a qualidade e toque em **Iniciar câmera**. Deixe o celular no tripé carregando; a tela fica ligada sozinha.
3. **Destinos:** se usar YouTube + Instagram, confira na aba Destinos se os dois estão ligados e com a chave do dia (a do Instagram muda a cada live).
4. **Holyrics:** na aba Holyrics, confira se está "conectado" e se **Mostrar a letra na live** está ligado. A letra do telão entra sozinha na transmissão.
5. **Tradução:** se houver visitantes que não falam português, aba Tradução → **Tradução ligada** → **Abrir o ouvinte neste PC** → **Começar a ouvir**. Eles leem o QR code da aba.
6. **Mesa:** abra http://localhost:8080/mesa no PC, ou `http://IP-DO-PC:8080/mesa` em um tablet.
7. Siga o **Roteiro**: o botão **Próximo** troca a cena e dispara a legenda configurada em cada item. Teclas **1 a 9** trocam cenas, **Espaço** avança o roteiro, **R** salva um replay.
8. **Multiview:** o botão no alto da mesa abre uma janela com o programa e todas as cenas ao vivo, para um segundo monitor ou TV. Clicar numa cena corta para ela.

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

## O OBS fica escondido: a mesa é a interface

Desde a versão 1.5 o OBS é só o motor. O programa abre o OBS junto, minimizado na bandeja, e tudo o que o operador precisa está na mesa:

- **Aba Fontes:** lista as webcams, microfones e outras fontes do OBS; troca o dispositivo de cada uma (qual webcam, qual entrada de som) e remove. **Adicionar** cria uma webcam, placa de captura ou captura de tela como uma cena nova com o mesmo nome, já com o overlay e os microfones; um microfone novo entra em todas as cenas.
- **Aba Telas:** monta uma cena com duas câmeras na mesma tela: **principal + canto** (pregador grande, telão ou banda pequeno num canto, 25 a 40% da tela), **lado a lado** (as duas recortadas para encher sem faixas pretas) ou **principal + faixa embaixo**. A tela nova já vem com overlay e microfones e aparece nas cenas e no multiview. A lista de cenas permite remover as que não usa mais.
- **Config → Qualidade da transmissão:** três predefinições (PC fraco 720p, padrão 1080p, alta 1080p60) ou valores próprios. Resolução e fps valem na hora; taxa de bits e codificador valem quando o OBS reinicia (botão **Reiniciar o OBS para valer**). O codificador por placa de vídeo só aparece se a placa existir (NVIDIA, Intel ou AMD).
- **Config → Conexão com o OBS:** "Abrir o OBS escondido" e "Abrir o OBS junto com este programa" podem ser desligados para quem prefere ver a janela do OBS. **Fechar OBS** fecha com cuidado (recusa se estiver transmitindo).
- Para abrir a janela do OBS quando precisar de algo que a mesa ainda não faz: ícone do OBS na bandeja do Windows → Mostrar.

## Áudio: mixer, filtros e fone do operador

Aba **Áudio** da mesa, por microfone ou fonte de som:

- **Mixer:** volume e mudo, como antes.
- **Fone:** o que o operador ouve no fone do PC: nada, só o operador (não vai para a transmissão) ou fone e transmissão. No OBS isso é o "monitoramento de áudio"; o dispositivo do fone fica em Configurações → Áudio → Dispositivo de monitoramento.
- **Voz de pregação:** um clique liga, na ordem certa, redução de ruído (RNNoise), portão, compressor e limitador com ajustes bons para fala. Dá para ligar e desligar cada um separadamente, escolher a força do portão e do compressor (leve, médio, forte) e acrescentar um **ganho** de −20 a +20 dB.
- Os filtros criados pela mesa têm nome "Mesa: …" no OBS; outros filtros já existentes aparecem só como informação. **Tirar filtros** remove só os da mesa.

## Player de vídeos (playlist)

Aba **Vídeos** da mesa: vídeos de avisos, abertura, testemunhos e encerramento tocam na transmissão sem abrir o OBS.

- **Lista:** **Enviar vídeo** copia o arquivo para `data/videos`; para vídeos grandes, cole o **caminho** de um arquivo que já está no PC (ex.: `D:\videos\aviso.mp4`). Reordene com ▲ ▼.
- **Tocar:** ▶ num item cria no OBS a cena "Vídeo" com a fonte "Player (vídeo)", corta para ela e mostra o progresso na mesa. **Pausar**, **Próximo** e **Parar e voltar** (volta para a cena de antes).
- **Ao terminar:** voltar para a cena anterior, tocar o próximo da lista ou repetir a lista sem parar (bom para o loop antes do culto).
- **Volume** do vídeo e opção de **silenciar os microfones** enquanto ele toca (devolve ao parar).
- **Roteiro:** ações "Vídeo: tocar" (escolhe um vídeo da lista) e "Vídeo: parar e voltar".
- Se o operador cortar para outra cena no meio do vídeo, o player para sozinho.

## Gráficos: tema, logo, QR de oferta, relógio e cartão em tela cheia

Tudo na aba **Gráficos** da mesa, e tudo vale na hora no overlay (a fonte de navegador do OBS):

- **Cartão em tela cheia:** título, texto de várias linhas e, se quiser, uma imagem de fundo (vira um banner) ou só a cor. Use para avisos, programação da semana, boas-vindas e encerramento. **Salvar modelo** guarda o cartão para reutilizar com um clique e para o roteiro (ação "Cartão em tela cheia: mostrar").
- **QR na tela:** cole a chave PIX, o "copia e cola" ou um endereço; escolha o rótulo, o canto e o tamanho. Ligue e desligue pela mesa ou pelo roteiro (ação "QR de oferta: mostrar/ocultar"). O QR é gerado pelo próprio programa, sem internet.
- **Logo da igreja:** envie um PNG com fundo transparente em **Imagens**, escolha o canto, a largura e a opacidade. Fica como marca-d'água em todas as cenas que têm o overlay.
- **Relógio:** hora atual num canto, 24 h ou 12 h.
- **Tema das legendas:** cor da igreja, fonte (das instaladas no Windows), estilo (clássico, moderno ou arredondado) e legenda inferior à esquerda ou centralizada. Vale para legendas, versículo, aviso, título, letra e cartão. Os parâmetros antigos `?accent=` e `?font=` na URL do overlay continuam valendo e ganham do tema.
- **Imagens:** envie PNG, JPG, GIF, WEBP ou SVG (até 25 MB). Ficam em `data/imagens` e aparecem como logo ou fundo de cartão.

## Transições e estinger

- **Transição padrão:** no cartão Cenas (ao lado dos botões) e na aba **Transições**, escolha a transição e a duração em milissegundos. Vale na hora para botões, teclas e roteiro. **Shift + clique** numa cena (ou Shift + tecla 1 a 9) corta seco, sem transição.
- **Transição por item do roteiro:** ao criar um item, escolha "Transição para esta cena" e a duração. Só aquele item usa essa transição; depois a padrão volta sozinha.
- **Estinger:** aba Transições → **Nova transição** → tipo *Estinger*. Envie o vídeo (um .webm com fundo transparente fica por cima da imagem; um .mp4 cobre a tela inteira), defina o **ponto de troca** (o instante, em ms, em que o vídeo cobre tudo e o OBS troca a cena por baixo) e clique em **Adicionar à lista** → **Aplicar e reiniciar o OBS**. Os vídeos ficam na pasta `data/estingers`.
- Também dá para criar **Esmaecer para uma cor**, **Deslizar** e **Varrer** do mesmo jeito. Corte e Esmaecer são do próprio OBS.
- Como o OBS só aceita transições novas pelo arquivo da coleção de cenas, aplicar fecha o OBS, grava o arquivo (deixando uma cópia `.antes-da-mesa`) e reabre em uns 15 segundos. Não faça isso com a transmissão no ar: a mesa recusa.

## Tradução ao vivo (para quem não entende português)

O que o pregador fala é reconhecido pelo navegador e traduzido na hora. Quem precisa lê (ou ouve pelo fone) no próprio celular, e o operador pode mostrar a tradução como legenda na transmissão.

Como funciona: (1) a página **ouvinte** (`/ouvir`), aberta no Edge ou Chrome do PC ou num celular perto do púlpito, escuta o microfone e manda o texto para a mesa; (2) a mesa envia cada frase ao serviço de tradução escolhido; (3) os celulares que abriram `/traducao` recebem as frases no idioma que escolheram.

Configuração, na aba **Tradução** da mesa:

1. **Serviço de tradução:** escolha o provedor e cole a chave; **Testar tradução** confere na hora.
   - **Claude (Anthropic):** melhor qualidade, entende o contexto do sermão e os nomes bíblicos. Crie a chave em console.anthropic.com e coloque créditos. O modelo padrão é o Opus 5.5; o Haiku 5.5 é mais rápido e muito mais barato (um culto inteiro custa centavos de dólar).
   - **DeepL:** plano gratuito com 500 mil caracteres por mês (uns 10 cultos); a chave gratuita termina em `:fx`.
   - **Google Tradutor:** sem chave, mas sem garantia (o Google pode bloquear sem aviso).
   - **Nenhum:** só transcreve em português; serve de legenda para quem tem dificuldade de audição.
2. **Idiomas oferecidos:** marque os idiomas que vão aparecer no celular dos membros.
3. Ligue **Tradução ligada** e clique em **Abrir o ouvinte neste PC**. Abre uma janela do Edge (ou Chrome); permita o microfone e clique em **Começar a ouvir**. Antes, escolha o microfone certo em **Configurações do Windows → Som → Entrada** (o ideal é a saída da mesa de som ligada no PC). Deixe a janela aberta o culto inteiro.
4. **Membros:** a pessoa lê o QR code da aba Tradução (ou da página inicial) no celular, aceita o aviso do certificado (igual às câmeras) e escolhe o idioma. O botão **🔊** lê em voz alta pelo fone de ouvido; **A-** e **A+** mudam o tamanho da letra.
5. Opcional: **Mostrar a tradução como legenda na transmissão** coloca a última frase traduzida no rodapé da live, no idioma escolhido. Ela some sozinha depois de 25 s sem fala nova.

Limites: o reconhecimento de voz é o do navegador (Google no Chrome, Microsoft no Edge) e precisa de internet. A frase só é traduzida quando o reconhecimento a fecha, então a tradução chega uns 2 a 5 segundos depois da fala. A janela do próprio programa não tem reconhecimento de voz: por isso o ouvinte abre no Edge ou Chrome.

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
| `http://localhost:8080/estingers/NOME` | vídeos de estinger enviados pela mesa |
| `http://localhost:8080/imagens/NOME` | imagens enviadas pela mesa (logo, fundos de cartão) |
| `http://localhost:8080/ouvir` | ouvinte da tradução: escuta o microfone (Edge ou Chrome). `?auto` começa a ouvir sozinho |
| `https://IP:8443/traducao` | tradução ao vivo no celular de quem não entende português |

## Problemas comuns

- **O celular diz que precisa de https.** Use o QR code, que já aponta para o endereço https. Se o IP do PC mudou, feche e abra o `iniciar.bat` de novo e apague a pasta `certs` para gerar um certificado com o IP novo.
- **O OBS abriu com uma janela de "assistente de configuração automática".** Acontece só na primeira abertura do OBS num PC novo. Clique em Cancelar; depois use a qualidade da mesa.
- **O microfone fica picotando ou cortando o começo das palavras.** O portão está forte demais: na aba Áudio, mude o portão para "leve" ou desligue-o. Em sala silenciosa o portão quase não é necessário.
- **A voz sai abafada ou robótica.** Desligue a redução de ruído para esse microfone; ela ajuda com ar-condicionado e chiado, mas mastiga vozes muito baixas.
- **O vídeo toca sem som ou com som baixo.** Confira o volume na aba Vídeos e, no OBS, se a fonte "Player (vídeo)" não está silenciada no mixer (aba Áudio da mesa).
- **O vídeo não aparece: tela preta na cena "Vídeo".** Formatos seguros: MP4 (H.264 + AAC) e WEBM. Vídeos muito pesados (4K, taxa de bits alta) travam em PC fraco: converta para 1080p antes.
- **A logo ou o QR não aparecem na transmissão.** O overlay precisa estar na cena (botão "Configurar OBS automaticamente" na aba Câmeras coloca a cena "Overlay" em todas). Confira também o selo "NA TELA" ao lado de cada item na aba Gráficos: a logo só liga depois de escolher uma imagem, e o QR só com conteúdo preenchido.
- **A transição nova não aparece depois de aplicar.** O OBS precisa fechar e abrir de novo; se ele não fechou (a mesa avisa), feche pelo ícone da bandeja do Windows e abra pela mesa. Se a coleção de cenas em uso no OBS for outra, a mesa mostra o nome da coleção no cartão "Transições na coleção do OBS".
- **O estinger não fica transparente.** Só vídeos .webm (VP9 ou VP8 com canal alfa) ou .mov com alfa têm transparência; .mp4 sempre cobre a tela inteira, o que também funciona como transição.
- **O ouvinte diz "navegador sem reconhecimento de voz".** Abra `http://localhost:8080/ouvir` no Microsoft Edge ou no Google Chrome (o botão da mesa tenta o Edge, depois o Chrome). Firefox e a janela do próprio programa não têm esse recurso.
- **O ouvinte reconhece, mas nada é traduzido.** Na aba Tradução, o contador mostra as falhas e o motivo (chave inválida, sem créditos, sem internet). Use **Testar tradução** para confirmar o serviço. A tradução só acontece com **Tradução ligada**.
- **O celular do membro não abre a página de tradução.** Mesmo caso das câmeras: precisa estar no Wi‑Fi da igreja e aceitar o aviso do certificado na primeira vez.
- **"Salvar replay" falha.** O buffer precisa estar ligado (selo verde "buffer ligado" na aba Replay). Se o OBS não tem o buffer de replay ativado nas configurações, use o botão **Ativar o replay no OBS** com o OBS fechado.
- **O Holyrics fica em "erro" na mesa.** A mensagem ao lado diz o motivo: "não aceitou a conexão" é API Server desligado ou IP errado; "token inválido" é token digitado errado ou sem a permissão GetCurrentPresentation; "tempo esgotado" costuma ser firewall no PC do Holyrics ou os PCs em redes diferentes.
- **O OBS fica vermelho na mesa.** Na aba Config veja o que ela diz sobre o OBS: se estiver fechado, use **Abrir OBS**; se o WebSocket estiver desligado, **Habilitar WebSocket do OBS** e reabra o OBS. Se mudou a senha no OBS, salve-a em "Configurar manualmente".
- **O Windows perguntou sobre o firewall.** Permita em redes **privadas**; sem isso os celulares não alcançam o PC.
- **A imagem no OBS congela.** Na aba Câmeras clique em **Reiniciar vídeo** no celular correspondente. Se cair muito, aproxime o roteador ou use 540p.
- **Um destino fica em "reconectando".** Clique em **Ver log** no destino para ver a mensagem do ffmpeg: normalmente é chave errada ou vencida (Instagram) ou internet sem banda para dois envios. O outro destino não é afetado.
- **Wi‑Fi com "isolamento de clientes" (comum em roteadores de visitante)** impede celular e PC de se verem. Use a rede principal.
- **Dois celulares com o mesmo nome.** O último que entrar substitui o anterior. Dê nomes diferentes na aba Config.
