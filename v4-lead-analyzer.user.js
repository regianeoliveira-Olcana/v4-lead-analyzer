// ==UserScript==
// @name         🔴 V4 Lead Analyzer
// @namespace    https://v4company.com
// @version      23.5
// @description  v23.5 · busca crua nao usa cidade de palpite nem nome generico (achou CNPJ de outra empresa)
// @author       V4 Company
// @match        *://brokers.mktlab.app/*
// @match        *://*.mktlab.app/*
// @updateURL    https://raw.githubusercontent.com/regianeoliveira-Olcana/v4-lead-analyzer/main/v4-lead-analyzer.user.js
// @downloadURL  https://raw.githubusercontent.com/regianeoliveira-Olcana/v4-lead-analyzer/main/v4-lead-analyzer.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_listValues
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      api.openai.com
// @connect      generativelanguage.googleapis.com
// @connect      google.serper.dev
// @connect      services.leadconnectorhq.com
// @connect      brasilapi.com.br
// @connect      app.outboundpro.com.br
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  function boot() {
    if (!document.body) { requestAnimationFrame(boot); return; }
    init();
  }
  boot();

  function init() {

  const VERSION = '23.5';
  const MAX_PARALLEL = 3;
  // v19.8: os 15s foram definidos quando o Gemini respondia em 3-4s — porque
  // não estava buscando (thinkingBudget 0). Com busca real o tempo observado
  // foi 10.7s num lead simples, e lead difícil estoura.
  //
  // Estourar não é neutro: o script cai pra OpenAI, que NÃO tem busca web.
  // O resultado vem do conhecimento do modelo, sem CNPJ e sem QSA — foi o que
  // produziu "empresa existe" sem nenhum dado no card do SERJA.
  //
  // 22s ainda cabe na janela do Compre Já e dá margem pro grounding terminar.
  const M1_TIMEOUT_MS = 22000;
  const M2_TIMEOUT_MS = 25000;   // Momento 2 — aprofundamento
  const M3_TIMEOUT_MS = 30000;   // Momento 3 — dossiê SDR
  const HEALTH_STALE_MS = 4 * 3600 * 1000;
  const HISTORY_TTL_MS = 30 * 24 * 3600 * 1000;

  // v22.0: credenciais do GHL — o lead comprado vai pro CRM com a análise
  function askGhlKeys() {
    const t = prompt(
      '🔗 GHL — envio automático do lead comprado\n\n'
      + 'Cole o Private Integration Token (começa com pit-):\n'
      + 'Configurações → Integrações → Chave de API privada\n\n'
      + 'Permissões necessárias: Contatos (ler/escrever) e Notas (escrever).'
    );
    if (!t || t.trim().length < 20) return null;
    GM_setValue('v4_ghl_token', t.trim());

    const l = prompt(
      'Agora o Location ID da subconta:\n\n'
      + 'Está na URL quando você está dentro dela:\n'
      + 'app.gohighlevel.com/v2/location/XXXXXXXX/dashboard'
    );
    if (l && l.trim().length >= 10) GM_setValue('v4_ghl_location', l.trim());
    v4Health = null;
    return t.trim();
  }

  // v21.0: chave da busca crua
  function askSerperKey() {
    const k = prompt(
      '⚡ Chave do Serper (busca web crua)\n\n'
      + 'Acha o CNPJ em ~1 segundo, antes da IA — resolve os casos em que o\n'
      + 'Google acha a empresa e o Gemini não.\n\n'
      + 'Cole a chave de serper.dev:'
    );
    if (!k || !k.trim() || k.trim().length < 16) return null;
    GM_setValue('v4_serper_key', k.trim());
    v4Health = null;
    return k.trim();
  }

  // ═══════════════════════════════════════════════════════════════
  // MOMENTO 1 — DECISÃO DE LANCE (curto de propósito: < 10s)
  // 3 checks: concorrente · empresa existe · decisor
  // ═══════════════════════════════════════════════════════════════
  const M1_PROMPT = `Auditor de leads B2B da V4 Company em leilão ao vivo.
V4 = assessoria de marketing digital. Comprar lead de agência concorrente é jogar dinheiro fora.

⏱️ ORÇAMENTO DE TEMPO — regra assimétrica (a janela do leilão é curta):

• ACHOU RÁPIDO? RESPONDA RÁPIDO. Se a primeira busca já trouxe site, CNPJ,
  Instagram ativo ou endereço no Maps, está resolvido — não procure mais.
  Responder em 3 segundos aqui é o comportamento CORRETO.

• VAI DIZER QUE NÃO ACHOU? SÓ DEPOIS DE ESGOTAR. Aí sim use o resto dos
  15 segundos. Motivo: concluir "não achei" é barato de produzir (basta não
  procurar) e caro pro negócio — rejeita empresa real e joga fora um lead bom.
  Errar pra "não existe" custa muito mais que gastar 10 segundos procurando.

Em resumo: o tempo extra é só pro caminho negativo. A maioria dos leads deve
sair em 3-5 segundos.

O cadastro é AUTORREPORTADO e frequentemente errado: nome incompleto, sobrenome omitido,
nome fantasia no lugar da razão social, cargo inflado, segmento que descreve o que o cliente
QUER contratar. Não confie no que está escrito — busque evidência externa.

Responda 3 perguntas. Use Google Search. Busque SEMPRE no Brasil (some UF/praça na query).

═══ 1) É CONCORRENTE? ═══
Uma busca: "[empresa]" agência OR marketing OR portfólio

true  → evidência de serviço de marketing PRESTADO A TERCEIROS
        (portfólio com cases de clientes, site "somos uma agência", LinkedIn de agência)
false → investigação mostra outro ramo (oficina, clínica, distribuidora, escola…)
null  → não deu pra determinar

⚠️ REGRA DE DEPENDÊNCIA — a mais importante desta seção:
NÃO DÁ PRA CLASSIFICAR O QUE VOCÊ NÃO IDENTIFICOU.
Se você não conseguiu determinar QUAL empresa é o lead (empresa_existe = "nao" ou
"parcial" por causa de nome genérico), então is_concorrente = null. Obrigatoriamente.

Achar que EXISTEM agências com aquele nome não prova que ESTE lead é agência.
Exemplo do erro: lead chamado "Pinheiro"; a busca acha "Pinheiro Company Marketing"
e "Agência Pinheiro" — mas também acha "Pinheiro Neto Advogados" e dezenas de
pessoas. Nada disso identifica o lead. Concluir "é concorrente" aí é chute.

Teste antes de marcar true: a evidência que você tem é DAQUELA empresa específica,
ou de outra que só tem nome parecido? Se for de outra, não serve.
Uma empresa que você listou em "homonimos_encontrados" NUNCA pode ser usada como
prova de concorrência — você mesmo disse que ela não é o lead.

⚠️ NOME PARECIDO NÃO BASTA. Nomes como "X Comunicação", "X Mídia", "X Performance",
"X Digital", "Studio X", "X Growth" APARECEM em agências, mas também em telecom,
mídia exterior, autopeças, fotografia, academia. Se o nome sugere agência e você
NÃO achou evidência de prestação a terceiros DAQUELA empresa:
  → is_concorrente = null  E  concorrente_suspeita = true
Nunca marque true só pelo nome. Falso positivo custa um lead bom.

⚠️ Campo "Segmento" com "Marketing" não faz a empresa ser agência — pode ser cliente
querendo contratar. Só o que ela FAZ conta.

═══ 2) A EMPRESA EXISTE? (esta, no Brasil) ═══

⚡ E-MAIL COM DOMÍNIO PRÓPRIO = ROTA MAIS CURTA. Se o contato usa e-mail que NÃO
é gmail/hotmail/outlook/yahoo, o domínio quase sempre É o site da empresa. Abra
esse domínio ANTES de procurar pelo nome: resolve empresa_existe, ramo e muitas
vezes CNPJ e cidade de uma vez. Nome de empresa erra (abreviado, genérico,
homônimo); domínio não erra. Se o site existe e é da empresa, empresa_existe = "sim".

⚠️ MUITO NEGÓCIO BRASILEIRO PEQUENO SÓ EXISTE NO INSTAGRAM. Sem site, sem Maps,
sem LinkedIn, sem CNPJ visível — e é empresa real, faturando. Concluir "não existe"
sem ter procurado o perfil é o erro mais caro que você pode cometer aqui.

BUSQUE, NESTA ORDEM:
1. "[empresa]" [cidade ou praça do DDD]
2. INSTAGRAM COM HANDLE — o @ não tem espaço nem acento. Para "LM Prime Visual",
   teste: instagram.com/lmprimevisual · "lmprimevisual" · "lm.prime.visual" ·
   "lmprime_visual" · site:instagram.com "LM Prime Visual"
   Faça o mesmo para Facebook (facebook.com/nomejunto).
3. "[empresa]" site OR loja OR contato Brasil
4. Marketplace (Shopee, Mercado Livre) e Google Maps pela cidade
5. Se o nome sugere o ramo (ex: "Visual" → comunicação visual; "Odonto" →
   odontologia; "Log" → logística), inclua isso na query: "[empresa]" comunicação visual

"sim"     → rastro no Brasil que bate com o lead (site ativo, Instagram com movimento
            ou endereço no Google Maps)
"parcial" → várias candidatas brasileiras sem como distinguir, ou 1 evidência fraca
"nao"     → nenhum rastro no Brasil

⚠️ Resultado estrangeiro é irrelevante. Acrescente UF, praça ou "Brasil" antes de desistir.
⚠️ DDD é DESEMPATE, nunca veto: com portabilidade o número acompanha a pessoa.
   DDD que bate reforça a candidata; DDD que não bate NÃO elimina.
⚠️ Homônimo não preenche site/instagram/endereço — deixe null se não é a empresa certa.
   ⚠️ "homonimos_encontrados" é SÓ pra empresa que pode ser confundida com o lead:
   mesmo país, ramo plausível, porte parecido. NÃO liste software estrangeiro,
   marca internacional, música, moeda, pessoa física famosa. Se você já achou o
   site ou o CNPJ da empresa certa, deixe o array VAZIO — não há ambiguidade a
   reportar, e listar ruído faz parecer que há dúvida onde não há.

═══ 3) O CONTATO É DECISOR? ═══
Ordem de prioridade (faça as 3 primeiras; a 4ª se sobrar tempo):

a) CRUZADO: "[empresa]" "[contato]"
   É a que mais resolve. Cai em LinkedIn com o cargo real, em Econodata/Casa dos Dados
   com o QSA (valida sócio E revela o CNPJ — REPORTE o CNPJ), ou no site da empresa.

b) LinkedIn DA EMPRESA: site:linkedin.com/company "[empresa]"
   • aba PESSOAS — o contato está listado? É o vínculo mais forte fora do QSA:
     prova que trabalha lá e mostra o cargo real
   • nº de funcionários — cruze com o faturamento declarado
     (5 funcionários declarando R$ 1M/mês não fecha)

c) LinkedIn DO CONTATO: "[contato]" "[empresa]" linkedin
   Faça inclusive em empresa pequena — funcionário costuma ter perfil.

d) Sobrenome: "[sobrenome]" "[empresa]" — em empresa pequena o sobrenome do contato
   costuma bater com o do dono (negócio familiar, mesmo sem constar no contrato).

⚠️ O QUE VALE COMO PROVA DE CARGO (e o que não vale):

   VALE:
   ✓ QSA da Receita / Econodata / Casa dos Dados nomeando a pessoa como sócio
   ✓ LinkedIn do contato com o cargo naquela empresa
   ✓ Aba Pessoas do LinkedIn da empresa listando a pessoa
   ✓ Página "equipe" / "sobre" / "quem somos" do site da empresa
   ✓ Notícia ou matéria descrevendo a pessoa como fundador/sócio/diretor
   ✓ Registro de classe (OAB, CRM, CRO, CREA) vinculado à empresa

   NÃO VALE — nunca use como prova de cargo:
   ✗ AVALIAÇÃO ou REVIEW (Google, TripAdvisor, iFood) que menciona o nome
     — quem avalia é CLIENTE, não dono
   ✗ comentário em post, curtida, marcação em foto
   ✗ depoimento de cliente no site
   ✗ nome parecido achado em contexto qualquer
   ✗ o cargo declarado no formulário

   Se sua única evidência é de um item da lista "NÃO VALE":
   → decisor_status = "nao"  e  decisor_papel = null
   Não costure fatos soltos ("o CNPJ existe" + "o nome aparece em algum lugar")
   para concluir um cargo. Isso é inventar.

⚠️ SEMPRE REPORTE O CARGO ACHADO quando a prova for válida, mesmo que baixo,
   mesmo contradizendo o cadastro. Achar "Assistente Comercial" onde o formulário
   diz "Diretor" é dos achados mais valiosos — muda a abordagem do SDR.

ALÇADA POR PORTE (desce conforme a empresa cresce):
  até R$ 399k/mês → precisa ser sócio, dono ou fundador
                    (nessa faixa "Diretor" costuma ser o dono ou título inflado)
  R$ 400k–1M      → sócio ou diretor
  R$ 1M–4M        → sócio, diretor ou C-level
  R$ 4M+          → diretor, head ou gerente sênior

⚠️ GERENTE EM EMPRESA GRANDE NÃO É LEAD RUIM. A partir de R$ 1M/mês a empresa tem
   estrutura: gerente, head e coordenador são contatos LEGÍTIMOS, com acesso ao
   decisor e muitas vezes donos do orçamento da própria área. Use "sem_alcada"
   (que já significa "lead segue bom, mapear quem decide"), NUNCA "nao".
   Confirmar um gerente vale MUITO mais que não confirmar ninguém.

decisor_status:
  "confirmado"  → papel comprovado por fonte externa E com alçada pro porte
  "sem_alcada"  → papel comprovado, mas sem poder de decisão (assistente, analista,
                  estagiário, ou gerente em empresa pequena) — LEAD SEGUE BOM,
                  o SDR só precisa mapear quem decide
  "indicio"     → sinal isolado, sem confirmação
  "nao"         → nada encontrado sobre a pessoa

RETORNE APENAS JSON:
{
  "is_concorrente": true|false|null,
  "concorrente_suspeita": true|false,
  "concorrente_evidencia": "1 frase com fonte, ou null",

  "empresa_existe": "sim"|"parcial"|"nao",
  "empresa_evidencia": "fontes que são DESTA empresa",
  "homonimos_encontrados": ["só as confundíveis — mesmo ramo ou região"],
  "buscas_feitas": ["liste as queries que você realmente rodou — obrigatório se empresa_existe = nao"],
  "site": "URL ou null",
  "instagram": "@ ou null",
  "ramo_aparente": "o que ESTA empresa faz, ou null se não confirmou",

  "decisor_status": "confirmado"|"sem_alcada"|"indicio"|"nao",
  "outras_empresas": [
    { "nome": "razão social ou fantasia", "cnpj": "CNPJ ou null",
      "cidade": "cidade/UF ou null", "papel": "Sócio-Administrador etc",
      "ramo": "o que faz, se souber", "e_a_do_lead": true|false|null }
  ],
  "buscas_feitas": ["queries rodadas — obrigatório se empresa_existe = nao"],
  "decisor_papel": "cargo REAL achado — preencha sempre que a busca mostrar algum",
  "decisor_evidencia": "1 frase com fonte, ou null",
  "decisor_fonte": "qsa"|"linkedin_contato"|"linkedin_empresa"|"site_empresa"|"noticia"|"registro_classe"|"outra"|null,
  "linkedin_contato": "URL ou null",
  "linkedin_empresa": "URL da company page, ou null",
  "contato_na_aba_pessoas": true|false|null,
  "funcionarios_linkedin": "faixa (ex: 11-50) ou null",
  "cargo_declarado_confere": true|false|null,
  "cnpj_descoberto": "CNPJ se apareceu, ou null",

  "resumo": "1 frase com o que os 3 checks NÃO dizem. Se não houver nada a acrescentar, deixe null — não repita os checks"
}

REGRAS FINAIS:
- Campo vazio = não achei. NÃO INVENTE.
- Só antes de fechar com "empresa_existe: nao", confira: rodei as buscas de handle
  (instagram.com/nomejunto, facebook.com/nomejunto)? busquei com a cidade? tentei
  o nome junto e separado? Se faltou alguma, rode agora — é o único caso em que
  vale gastar o resto do tempo.
- NUNCA derive o ramo do campo "Segmento" do formulário. Sem evidência externa,
  ramo_aparente = null. Admitir que não sabe vale mais que um palpite.
- Homônimo (outra cidade, outro país) não prova que a empresa existe.
- Se achou CNPJ em qualquer fonte, reporte sempre.
- Profundidade extra é a fase 2. Aqui, responda o que dá com confiança.`;

  // ═══════════════════════════════════════════════════════════════
  // MOMENTO 2 — APROFUNDAMENTO (quando o M1 não fechou)
  // ═══════════════════════════════════════════════════════════════
  const M2_PROMPT = `Auditor investigativo da V4 Company. O leilão esquentou e o LDR precisa decidir
se vale escalar o lance. A investigação rápida NÃO fechou — agora você tem tempo pra ir fundo.

Cadastro é autorreportado e pode estar errado de propósito ou por descuido.
Investigação externa prevalece sempre.

O QUE APROFUNDAR:

0) RESOLVER O QUE O MOMENTO 1 DEIXOU EM ABERTO (prioridade máxima)

   O momento 1 já rodou as buscas básicas (nome + cidade, handles de Instagram e
   Facebook, site, Maps). Não repita o que ele fez — vá além:
   fontes cadastrais (Econodata, Casa dos Dados, Jusbrasil, Reclame Aqui),
   marketplaces, aba Vagas do LinkedIn, domínio do e-mail, grafias alternativas,
   e outro CNPJ da mesma família ou do mesmo sócio.

   Se veio concorrente_suspeita=true (nome sugere agência, sem evidência):
   Tente resolver. Abra o site e o Instagram DA EMPRESA DO LEAD. Procure portfólio,
   cases, "nossos clientes", tabela de serviços.

   ⚠️ MAS: só conclua true ou false se você IDENTIFICOU a empresa do lead.
   Se o nome é genérico e você não sabe qual das várias homônimas é o lead,
   mantenha is_concorrente = null. Isso NÃO é falha — é a resposta correta.
   Concluir "é concorrente" porque existem agências com nome parecido é erro grave:
   veta um lead que pode ser bom. Preferir null a errar.

   Lembre: "Comunicação", "Mídia", "Performance", "Digital" aparecem em telecom,
   mídia exterior, autopeças, fotografia, academia.

   Se veio decisor_status = "nao" ou "indicio":
   • Verificação de DOMÍNIO do e-mail: se não é gmail/hotmail/outlook, abra o
     domínio. Existe? Tem site no ar? É da MESMA empresa do lead? Domínio próprio
     ativo é sinal forte de empresa formalizada. Domínio que não resolve, ou de
     outra empresa, é red flag. Preencha dominio_confere.
   • Aba VAGAS do LinkedIn da empresa: o que está contratando revela estrutura e
     prioridade do momento — vira gancho de abertura pro SDR.

   Se veio empresa_existe = "parcial" ou "nao":
   • VARIAÇÕES DE GRAFIA: junto/separado, por extenso, com/sem acento
     (ex: "4Home", "4 Home", "Four Home", "FourHome")
   • HANDLES DE REDE SOCIAL (o mais esquecido): instagram.com/nomejunto,
     facebook.com/nomejunto, com e sem ponto, com e sem underline.
     "LM Prime Visual" → lmprimevisual · lm.prime.visual · lmprime_visual
     Muita empresa pequena real NÃO tem site nem CNPJ visível — só o perfil.
   • MARKETPLACES: Shopee, Mercado Livre, Amazon — a página do vendedor costuma
     expor CNPJ e cidade. Resolve empresa que só vende online.

1) EMPRESA — esgote as variações, SEMPRE no Brasil
   • Combine o nome com a UF e a praça do DDD (vem no contexto acima)
   • Nome com/sem sufixo (LTDA, ME), com/sem acento, abreviado, junto/separado
     (ex: "4Home", "4 Home", "Four Home", "FourHome")
   • Domínio do e-mail (se corporativo, o domínio É a empresa real — abra e veja)
   • Sobrenome do contato + praça do DDD + ramo
   • Reclame Aqui, Econodata, Casa dos Dados, Jusbrasil, Guia Mais, jornais locais
   • Instagram/Facebook filtrando por localização
   • Marketplace (Shopee, Mercado Livre, Amazon) — loja com nome igual costuma
     ter CNPJ e cidade visíveis na página do vendedor

   Se houver várias homônimas brasileiras, use o DDD pra escolher e DIGA qual
   escolheu. Nunca conclua "não existe" sem ter tentado com UF e praça.

   ⚠️ DDD divergente da UF NÃO é contradição nem red flag — a portabilidade permite
   manter o número mudando de cidade/estado. Não inclua isso em "contradicoes"
   nem em "red_flags". Se tudo o mais bate, a empresa é a mesma.

2) DECISOR — esgote as rotas (e SEMPRE reporte o cargo real que achar)

   ⚠️ Vale como prova: QSA, LinkedIn (perfil ou aba Pessoas), página de equipe do
   site, notícia nomeando como sócio/fundador, registro de classe.
   NÃO vale: avaliação/review, comentário em post, marcação em foto, depoimento de
   cliente. Quem avalia um negócio é cliente, não dono. Sem prova válida:
   decisor_status = "nao".
   • CRUZADO: "[empresa]" "[contato]" → Econodata/Casa dos Dados mostram QSA + CNPJ
   • LinkedIn da EMPRESA (site:linkedin.com/company) → aba Pessoas: o contato está
     listado? Que cargo? Quantos funcionários a empresa declara?
     Aba Vagas: o que está contratando revela estrutura e prioridade
   • Se o contato NÃO aparece na aba Pessoas mas a empresa tem página ativa com
     vários funcionários listados, isso é sinal (fraco) de que ele pode não
     trabalhar lá — registre, mas não conclua: muita gente não usa LinkedIn
   • Sobrenome do e-mail (ex: joao.pereira@ → buscar "Pereira" + empresa)
   • Se o sobrenome bate com o nome da empresa → provável empresa familiar
   • 👪 SOBRENOME NO QSA: se o contato divide sobrenome com algum sócio
     (ex: contato "Eli Tavares" e QSA com "Carliene Tavares" e "Edcarlos Tavares"),
     é forte indício de empresa familiar. Em micro/pequena empresa brasileira o
     filho, cônjuge ou irmão costuma operar o negócio sem constar no contrato social.
     Busque: "[primeiro nome] [sobrenome]" "[cidade]" · "[sobrenome]" "[empresa]"
     Também procure OUTRO CNPJ da mesma família no mesmo ramo/cidade —
     é comum a família ter mais de uma empresa e a ativa não ser a do lead.
   • 📝 NOME CURTO PODE SER REDUÇÃO: "Eli" pode ser Elias, Eliane, Elizabete,
     Elizeu. "Tica", "Bia", "Zé" são apelidos. Ao buscar, teste as variações
     completas junto com o sobrenome e a cidade., sócio
   • Notícias, atas, processos, registros de classe (CRM, CRO, OAB, CREA)
   • Se achar CNPJ, REPORTE — destrava consulta oficial

3) RAMO REAL E MARGEM
   Determine o que a empresa REALMENTE vende, com base em EVIDÊNCIA EXTERNA
   (site, Instagram, Maps, CNAE, notícia). "Varejo" cobre joalheria (55%) e
   mercearia (3%) — precisa ser específico.

   ⚠️ NÃO estime margem nem EBITDA — saiu do sistema. A classificação vem de uma
   régua fixa por segmento, aplicada localmente. O que você precisa entregar é o
   RAMO REAL específico e bem descrito. Se mencionar margem, é só contexto do setor
   — e nunca use "lucro presumido", que é base de cálculo de imposto.

   ⚠️ PROIBIDO inferir o ramo a partir do campo "Segmento" do formulário.
   Ele é autorreportado e frequentemente descreve o que o cliente QUER contratar,
   não o que ele faz. Se a investigação não determinou o ramo:
   → ramo_real = null, ramo_confianca = "baixa", margem = null
   NUNCA escreva "com base no segmento declarado". Sem evidência externa,
   o ramo é DESCONHECIDO — e admitir isso vale mais que um palpite.

4) MAIS DE UM CANDIDATO? ORDEM DE DESEMPATE
   Quando sobrar mais de uma empresa possível, desempate NESTA ordem:

   1º PREFIXO DO CNPJ — se o cadastro trouxe dígitos, eles mandam. Não bate,
      não é a empresa. Ponto.
   2º RAZÃO SOCIAL COMPLETA — o termo extra costuma resolver. "JM Representações
      e Merchandising" contra "JM Representações": o "Merchandising" descarta.
   3º SÓCIO NO QSA — promove o candidato quando bate. Mas NÃO rebaixa quando não
      bate: o contato pode ser filho, cônjuge ou funcionário e ainda ser a pessoa
      certa.
   4º PRESENÇA DIGITAL — site e redes com movimento recente. Também só promove.
      Ausência de presença digital não descarta ninguém: PME brasileira raramente
      tem rastro.
   5º ENDEREÇO — é o único critério que separa matriz de filial.
   6º CIDADE/UF — o mais fraco, porque costuma ter sido o próprio filtro da busca.

   ⚠️ Se a cidade foi o que você usou pra buscar, ela não pode depois ser citada
   como prova de que achou a empresa certa. Isso é circular.

   ⚠️ NÃO devolva dois candidatos pra quem compra escolher. Quem compra tem os
   mesmos segundos e as mesmas fontes. Se nada bate com segurança:
   empresa_existe = "nao".

5) EMPRESAS NO NOME DO CONTATO — FAÇA SEMPRE
   ⚠️ Se o cadastro trouxe dígitos do CNPJ, confira o CNPJ de CADA empresa que
   você achar no nome do contato contra esses dígitos. Caso real: o lead trazia
   68777 e a investigação achou 4 empresas de "Antonio Bomfim" sem conferir o
   CNPJ de nenhuma — a certa podia estar entre elas.
   Não basta checar se ele é sócio DA empresa do lead. Procure TODAS as empresas
   em que ele aparece como sócio ou administrador:

   "Nome Completo" sócio CNPJ
   "Nome Completo" cidade empresa
   "Nome Completo" quadro societário
   (Casa dos Dados, Econodata, Serasa Experian e Casa Civil indexam isso)

   ⚠️ ACHAR OUTRAS EMPRESAS É SINAL BOM, NÃO RED FLAG.
   Quem tem CNPJ no próprio nome é dono: tem capital, decide sozinho e conhece
   o custo de aquisição. Um contato com 2-3 negócios vale MAIS que um contato
   sem rastro — mesmo que a empresa do lead não seja a que você achou.

   Preste atenção em dois padrões:
   • RAZÃO SOCIAL POR INICIAIS — "J N V COMERCIO LTDA" é Jose Nelio Vanço.
     Muito comum em negócio pequeno. Se o nome do lead é sigla curta, teste as
     iniciais do contato.
   • MESMA CIDADE OU MESMO SOBRENOME — empresa achada na cidade do contato, ou
     com o sobrenome dele na razão social, provavelmente é o negócio dele ou da
     família, mesmo com nome fantasia diferente.

   Se a empresa que você achou fica em cidade DIFERENTE da do contato, diga isso
   explicitamente — pode ser homônima, não o negócio dele.

6) COERÊNCIA
   Faturamento declarado × porte aparente: coerente?
   Cidade declarada × DDD × endereço achado: bate?
   Nome declarado × domínio do e-mail: bate?
   Cargo declarado × papel real: bate?
   Contradições são sinal de dado inflado ou mascarado.

RETORNE APENAS JSON:
{
  "is_concorrente": true|false|null,
  "concorrente_evidencia": "frase ou null",

  "empresa_existe": "sim"|"parcial"|"nao",
  "empresa_evidencia": "fontes encontradas",
  "site": "URL ou null",
  "instagram": "@ ou null",
  "endereco": "endereço ou null",

  "ramo_real": "o que a empresa vende, específico — null se não confirmou por fonte externa",
  "ramo_confianca": "alta"|"media"|"baixa",
  "margem_estimada_min": número (%) ou null,
  "margem_estimada_max": número (%) ou null,
  "margem_justificativa": "por que essa faixa — null se ramo não confirmado",

  "decisor_confirmado": "sim"|"parcial"|"nao",
  "decisor_papel": "cargo REAL achado — preencha sempre, mesmo sendo baixo ou contradizendo o cadastro",
  "decisor_evidencia": "frase com fonte",
  "decisor_fonte": "qsa"|"linkedin_contato"|"linkedin_empresa"|"site_empresa"|"noticia"|"registro_classe"|"outra"|null,
  "linkedin_contato": "URL ou null",
  "linkedin_empresa": "URL da company page, ou null",
  "contato_na_aba_pessoas": true|false|null,
  "funcionarios_linkedin": "faixa (ex: 11-50) ou null",
  "vagas_abertas": ["vaga que revela estrutura/prioridade"],
  "decisor_status": "confirmado"|"sem_alcada"|"indicio"|"nao",
  "outras_empresas": [
    { "nome": "razão social ou fantasia", "cnpj": "CNPJ ou null",
      "cidade": "cidade/UF ou null", "papel": "Sócio-Administrador etc",
      "ramo": "o que faz, se souber", "e_a_do_lead": true|false|null }
  ],
  "buscas_feitas": ["queries rodadas — obrigatório se empresa_existe = nao"],
  "cargo_declarado_confere": true|false|null,
  "dominio_confere": true|false|null,
  "empresa_familiar": true|false|null,
  "parentesco_provavel": "relação sugerida pela evidência (filho/cônjuge/irmão/sócio informal) ou null",
  "outro_cnpj_familia": "CNPJ de outra empresa da mesma família no mesmo ramo, ou null",
  "nome_pode_ser_reducao": true|false|null,
  "cnpj_descoberto": "CNPJ ou null",

  "contradicoes": ["declarado X vs achado Y"],
  "red_flags": ["flag"],

  "resumo": "2 frases: o que mudou em relação à investigação rápida"
}

REGRAS:
- Não invente. Campo vazio = não achei.
- Ramo real específico, com fonte externa. NUNCA derivado do segmento declarado.
- Homônimo de outra cidade/país não prova nada — reporte separado.
- NÃO classifique concorrente sem ter identificado a empresa. Se empresa_existe
  ficou "nao"/"parcial" por nome genérico, is_concorrente = null.
- Empresa listada em "homonimos_encontrados" não pode virar prova de nada.
- Se achou CNPJ, reporte sempre.
- Se o momento 1 e a sua investigação divergirem, explique a divergência no resumo.`;

  // ═══════════════════════════════════════════════════════════════
  // MOMENTO 3 — DOSSIÊ PRO SDR (lance ganho, sem pressa)
  // ═══════════════════════════════════════════════════════════════
  const M3_PROMPT = `Auditor da V4 Company. O lance foi ganho. Monte o dossiê pro SDR qualificar com assertividade.
Use TUDO que foi levantado (investigação web + BrasilAPI + OutboundPro).
Zero alucinação — só o que está nos dados fornecidos.

COMO USAR A CLASSIFICAÇÃO DE MARGEM:

O contexto traz o veredito da matriz margem × faturamento: bucket do segmento
(alta >50% · média 30-50% · baixa <30%) cruzado com a faixa de faturamento.

⚠️ NÃO calcule valor endereçável, NÃO estime EBITDA, NÃO sugira ticket ou fee.
Isso saiu do sistema. O closer define o valor na conversa.

Regras:
• Diga o bucket e por que importa: margem baixa significa que o cliente sente
  mais o custo do serviço, então a venda exige mais porte.
• VERDE → o porte sustenta o investimento. Sem citar número.
• AMARELO por faturamento não confirmado → a primeira tarefa do SDR é confirmar
  o faturamento real dos últimos 12 meses.
• VERMELHO → o segmento nesse porte historicamente não sustenta o investimento
  comercial. O SDR pode discordar com informação nova.
• Faixa do LeadBroker cruzando dois tiers → traga a pergunta que resolve.
• Abaixo de R$ 100k/mês não desqualifica: a conversa passa a ser de SABER
  (diagnóstico parcelável) ou TER (martech ou entregável pontual). Escreva de
  forma afirmativa, nunca como "lead pequeno demais".

FATURAMENTO DECLARADO vs. RECEITA — DOIS NÍVEIS:

Se o contexto traz "RESSALVA DE FATURAMENTO (não bloqueante)":
• O declarado não bate com o porte, MAS mesmo um valor bem menor segue dentro do ICP
• Trate como ponto de confirmação, NÃO como problema — o lead continua bom
• Uma linha no dossiê basta: "confirmar faturamento real; porte na Receita sugere
  valor menor, provavelmente porte desatualizado (empresa cresceu e não reenquadrou)"
• Mantenha a leitura da matriz, marcando que depende de confirmar o faturamento

Se o contexto traz "FATURAMENTO PODE ESTAR FORA DO ICP":
• O declarado já era baixo E o porte sugere um valor ainda menor
• Destaque no TOPO — o SDR precisa confirmar antes de investir tempo
• Instrua a confirmar logo na abertura:
  "Só pra eu dimensionar certo — qual foi o faturamento dos últimos 12 meses?"
• NÃO trate a classificação como firme; marque "a confirmar na ligação"

Sobre ICP: o ICP core da V4 começa em R$ 100k/mês. Abaixo disso o lead está fora do
ICP core, MAS segue qualificado para SABER (diagnóstico, parcelável) e TER (martech
recorrente ou entregável pontual). Diga isso de forma neutra e afirmativa — é outro
tipo de conversa, não um lead ruim. Nunca escreva "lead pequeno demais" ou similar.

Nos dois casos, explique sem acusar. Três causas possíveis, todas comuns:
(a) número arredondado pra cima no formulário, (b) porte desatualizado na Receita,
(c) o contato citou o faturamento do grupo, não daquele CNPJ.

Referência dos tetos: MEI R$ 81k/ano · Microempresa R$ 360k/ano · EPP R$ 4,8M/ano.

CLASSIFICAÇÃO DE CONCORRENTE INVÁLIDA:
Se o contexto traz esse aviso, a investigação afirmou "é concorrente" sem ter
identificado a empresa. Isso é chute. NÃO repita a afirmação. Escreva que o ramo
não foi determinado e sugira a pergunta de abertura: "só pra eu entender melhor —
o que exatamente vocês fazem/vendem?"

EVIDÊNCIA DE CARGO INVÁLIDA:
Se o contexto traz esse aviso, a investigação usou fonte que não prova vínculo
(avaliação do Google, comentário, depoimento). Escreva "papel real: não comprovado"
mesmo que a investigação tenha afirmado um cargo. Não repita a afirmação sem base.

DECISOR SEM ALÇADA — NÃO É LEAD RUIM:
Se decisor_status = "sem_alcada", a investigação achou o cargo real e ele não decide
(assistente, analista, gerente em empresa pequena). Isso é INFORMAÇÃO BOA, não veto:
• A empresa existe e alguém está pesquisando fornecedor — há interesse real
• O SDR precisa mapear quem decide sem constranger o contato
• Pergunta certa: "além de você, quem mais participa dessa decisão?"
• Pergunta errada: "você tem autonomia?" / "você é o dono?"
• Assistente pesquisando a mando do dono é cenário comum e legítimo

SUSPEITA DE CONCORRENTE NÃO RESOLVIDA:
Se concorrente_suspeita = true e is_concorrente continua null, o nome sugere agência
mas não houve evidência. Trate como ponto de confirmação na abertura, não como veto:
"Só pra eu entender o negócio de vocês — o que exatamente vocês fazem/vendem?"

DIVERGÊNCIA DE CARGO — SEMPRE DESTACAR:
Se a investigação achou um cargo real diferente do declarado no cadastro
(ex: formulário diz "Diretor", LinkedIn diz "Assistente Comercial"), isso é
informação de PRIMEIRA ORDEM e deve aparecer no topo do dossiê:
• O contato provavelmente NÃO decide — é influenciador ou pesquisador
• O SDR precisa mapear quem decide de fato, sem constranger o contato
• Sugira a pergunta de mapeamento: "além de você, quem mais participa
  dessa decisão?" — nunca "você tem autonomia pra decidir?"
• Não trate como mentira: assistente pesquisando fornecedor a mando do dono
  é cenário comum e legítimo. Muda a abordagem, não desqualifica o lead.

SINAIS DO LINKEDIN DA EMPRESA:
Quando o contexto traz dados da company page, use assim:
• Contato listado na aba Pessoas = vínculo comprovado. Cite como evidência forte.
• Número de funcionários vs. faturamento declarado: incoerência grosseira
  (ex: 5 funcionários para R$ 1M/mês) vira ponto de confirmação, não acusação.
• Vagas abertas revelam prioridade do momento e dão gancho de abertura pro SDR
  (contratando vendedor = está querendo crescer comercial; contratando marketing
  = pode já ter time interno, muda a conversa).
• Contato ausente da aba Pessoas NÃO prova nada — muita gente não usa LinkedIn.

VÍNCULO FAMILIAR (👪):
Quando o contexto traz "PROVÁVEL VÍNCULO FAMILIAR", o contato divide sobrenome com
sócio do QSA. Em micro e pequena empresa isso quase sempre significa filho(a),
cônjuge ou irmão(ã) operando o negócio.

Como o SDR deve usar:
• É acesso provável ao decisor — não desqualifique por não estar no contrato social
• A pessoa pode ser quem realmente toca a operação, com o pai/mãe só no papel
• Pergunta de mapeamento, sem constranger: "além de você, quem mais participa
  dessa decisão?" — NUNCA "você é o dono?" ou "você tem autonomia?"
• Se a investigação achou outro CNPJ da mesma família no mesmo ramo, mencione:
  pode ser que a operação real esteja no outro CNPJ

CONTATO FORA DO QSA:
Se o CNPJ foi resolvido e o contato NÃO aparece no quadro societário, diga isso —
mas sem tratar como problema por si só. Funcionário, gerente ou parente do sócio
são cenários normais. O que importa é cruzar com o cargo real achado na
investigação e orientar o SDR a mapear quem decide.

CONFIRMAR A MARGEM NA LIGAÇÃO:
A classificação vem de uma régua por segmento, não da margem real do cliente.
Traga sempre a pergunta que o SDR usa:

"Dos R$ X que entram por mês, depois de pagar tudo — mercadoria, folha, aluguel,
imposto, empréstimo — quanto sobra de fato? E quanto é a sua retirada?"

No Simples Nacional o DAS mistura tudo e o dono raramente sabe separar. Em negócio
pequeno o pró-labore some dentro do "lucro", então o número que ele informa costuma
ser MENOR que a capacidade real de investimento.

Se o subsegmento tem fonte 'estimativa sem fonte', diga explicitamente que a faixa
de margem é estimativa e não tem pesquisa por trás.

DOR DO SEGMENTO:
Quando o contexto traz "Dor típica do segmento", use como HIPÓTESE a validar,
nunca como fato. Combine com o que a investigação achou do negócio específico.

FORMATO DE SAÍDA:

═══ [EMPRESA] ═══
[FAROL: GO / CAUTION / STOP — copie o que o contexto trouxe]
Faturamento declarado: [X]  ·  Tier: [X]
Ramo real (investigado): [X]  ·  fonte: [CNAE da Receita / investigação web]

[SE o contexto trouxer "SINAIS DE PORTE MAIOR QUE O DECLARADO", abra com isto,
 antes de tudo — é o que muda a decisão:]
⚡ PORTE PODE SER MAIOR QUE O DECLARADO
   [liste os sinais que vieram no contexto, separados por · ]
   O declarado é [X]. Confirmar o faturamento real é a primeira tarefa.

OS 4 BOXES
[✅/⚠️/🚨] Concorrente — [o que foi apurado]
[✅/⚠️/❌] Empresa — [existe? quantas fontes? quais?]
[✅/⚠️/❌] Decisor — [papel + como foi confirmado, ou o que falta]
[✅/⚠️/❌] Margem — [bucket · segmento] · ICP a partir de [corte do bucket]/mês

⚠️ NÃO invente percentual de margem nem estime lucro. Use o bucket que veio no
contexto (alta >50% · média 30-50% · baixa <30%) e o corte de ICP. Nada de
"lucro bruto ≈ R$ X".

DADOS OFICIAIS (se houver CNPJ)
CNPJ · Razão social · Situação · Abertura · Capital · CNAE
QSA: [sócios]
[se o contato bate no QSA: informe a CONFIANÇA e a BASE do match, não só "é sócio".
 Ex: "confiança alta — 'Eugenio Leite' está contido em 'Bruno Eugenio Leite da Silva',
 e a empresa é sociedade individual (um titular só)".
 Se a confiança for média/baixa ou ambígua, diga que precisa confirmar na ligação.]
[se divergência de nome fantasia × razão social: normal no Brasil, não invalida]
[SE o contexto trouxer que a razão social cita atividade fora do CNAE, diga as DUAS:
 "CNAE registra [X], mas a razão social cita [Y] — a empresa faz mais de uma coisa".
 Isso é informação pro SDR, não erro de cadastro.]

CONTATO
Declarado: "[nome]"  ·  cargo declarado: "[cargo]"
Papel real: [X ou "não comprovado"]
Vínculo familiar: [sobrenome coincidente no QSA, ou "não identificado"]
E-mail: [X]  ·  domínio: [corporativo/genérico]
[se sobrenome saiu do e-mail: sobrenome extraído do e-mail: X]

ROTEAMENTO DE PILAR
→ Recomendado: [SABER / TER / EXECUTAR]
   Por quê: [justificativa ligada ao bucket de margem e ao corte de ICP]
→ Descartado: [pilar] — [motivo]
→ Caminho de upsell: [se aplicável]
[SE houver sinais de porte maior que o declarado, escreva que o roteamento pode
 mudar depois de confirmar o faturamento — não feche a porta do EXECUTAR.]

⚠️ CONTRADIÇÕES / RED FLAGS
• [declarado X vs achado Y]

SDR — QUALIFICAÇÃO ASSERTIVA
↳ Dor provável (baseada no ramo REAL): [específica]
↳ Abrir a conversa por: [ângulo — martech? diagnóstico? tráfego?]
↳ [SE o CNPJ do cadastro não foi confirmado, a PRIMEIRA pergunta é o CNPJ —
   com ele todo o resto se resolve: ramo real, porte, sócios, tempo de casa.
   "Pra eu puxar o histórico de vocês aqui, me confirma o CNPJ?"]
↳ Confirmar na ligação:
   1. [pergunta que valida o papel do contato]
   2. [pergunta que valida faturamento/margem]
   3. [pergunta que valida a dor do pilar recomendado]
↳ Alçada esperada: [nível]
↳ Se for concorrente: NÃO ESCALAR.

Sem CNPJ é normal no leilão — não trate como falha.
Empresa pequena sem LinkedIn é normal.
Cadastro é ponto de partida; investigação é a verdade.`;

  // ═══════════════════════════════════════════════════════════════
  // v11.4: tabela de 64 subsegmentos com EBITDA REMOVIDA — substituída pela
  // matriz margem × faturamento (MARGEM_SEGMENTO + MATRIZ).


  // Ajuste de margem por perfil de escala × tier (aba Premissas Comerciais)


  // Tier × WTP (recorte comercial V4 — receita MENSAL)


  const FEE_MINIMO_UNIDADE = 6500;  // ⚠️ ajustar ao horizonte da unidade (H3 → H4)
  const VERBA_MIDIA_MIN = 3000;     // mínimo de verba de mídia (por fora do fee)

  function normalizarTexto(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }



  // ═══════════════════════════════════════════════════════════════
  // DDD → UF / praça (v8.14)
  // Nome genérico ("4 Home", "Prime", "Casa Nova") retorna dezenas de empresas.
  // O DDD do telefone é o desempate mais barato que existe: dá a região real
  // mesmo quando o lead não preencheu cidade.
  // ═══════════════════════════════════════════════════════════════
  const DDD_MAPA = {
    11: ['SP', 'São Paulo'], 12: ['SP', 'Vale do Paraíba / São José dos Campos'],
    13: ['SP', 'Baixada Santista'], 14: ['SP', 'Bauru / Marília'],
    15: ['SP', 'Sorocaba'], 16: ['SP', 'Ribeirão Preto / São Carlos'],
    17: ['SP', 'São José do Rio Preto'], 18: ['SP', 'Presidente Prudente / Araçatuba'],
    19: ['SP', 'Campinas / Piracicaba'],
    21: ['RJ', 'Rio de Janeiro'], 22: ['RJ', 'Campos / Macaé'], 24: ['RJ', 'Volta Redonda / Petrópolis'],
    27: ['ES', 'Vitória'], 28: ['ES', 'Cachoeiro de Itapemirim'],
    31: ['MG', 'Belo Horizonte'], 32: ['MG', 'Juiz de Fora'], 33: ['MG', 'Governador Valadares'],
    34: ['MG', 'Uberlândia'], 35: ['MG', 'Poços de Caldas / Varginha'],
    37: ['MG', 'Divinópolis'], 38: ['MG', 'Montes Claros'],
    41: ['PR', 'Curitiba'], 42: ['PR', 'Ponta Grossa'], 43: ['PR', 'Londrina'],
    44: ['PR', 'Maringá'], 45: ['PR', 'Foz do Iguaçu / Cascavel'], 46: ['PR', 'Pato Branco'],
    47: ['SC', 'Joinville / Blumenau / Itajaí'], 48: ['SC', 'Florianópolis / Criciúma'], 49: ['SC', 'Chapecó / Lages'],
    51: ['RS', 'Porto Alegre'], 53: ['RS', 'Pelotas / Rio Grande'],
    54: ['RS', 'Caxias do Sul'], 55: ['RS', 'Santa Maria / Passo Fundo'],
    61: ['DF', 'Brasília e entorno'], 62: ['GO', 'Goiânia'], 64: ['GO', 'Rio Verde / Itumbiara'],
    63: ['TO', 'Palmas'], 65: ['MT', 'Cuiabá'], 66: ['MT', 'Rondonópolis / Sinop'], 67: ['MS', 'Campo Grande / Dourados'],
    68: ['AC', 'Rio Branco'], 69: ['RO', 'Porto Velho / Ji-Paraná'],
    71: ['BA', 'Salvador'], 73: ['BA', 'Ilhéus / Porto Seguro'], 74: ['BA', 'Juazeiro'],
    75: ['BA', 'Feira de Santana'], 77: ['BA', 'Barreiras / Vitória da Conquista'],
    79: ['SE', 'Aracaju'], 81: ['PE', 'Recife'], 87: ['PE', 'Petrolina / Caruaru'],
    82: ['AL', 'Maceió'], 83: ['PB', 'João Pessoa / Campina Grande'],
    84: ['RN', 'Natal'], 85: ['CE', 'Fortaleza'], 88: ['CE', 'Juazeiro do Norte / Sobral'],
    86: ['PI', 'Teresina'], 89: ['PI', 'Picos / Floriano'],
    91: ['PA', 'Belém'], 93: ['PA', 'Santarém'], 94: ['PA', 'Marabá'],
    92: ['AM', 'Manaus'], 97: ['AM', 'interior do Amazonas'],
    95: ['RR', 'Boa Vista'], 96: ['AP', 'Macapá'],
    98: ['MA', 'São Luís'], 99: ['MA', 'Imperatriz'],
  };

  function regiaoPorDDD(ddd) {
    const m = DDD_MAPA[ddd];
    if (!m) return null;
    return { uf: m[0], praca: m[1], texto: `${m[1]}/${m[0]}` };
  }

  // ═══════════════════════════════════════════════════════════════
  // COERÊNCIA: porte na Receita × faturamento declarado (v8.4)
  // Tetos legais de receita bruta anual — se o declarado estoura o teto
  // do porte registrado, o número do formulário está inflado (ou o porte
  // está desatualizado). Nos dois casos o cálculo de endereçável degrada.
  // ═══════════════════════════════════════════════════════════════
  // ICP CORE começa em R$ 100k/mês. Abaixo disso o lead está FORA do ICP core,
  // mas SEGUE QUALIFICADO para SABER (diagnóstico parcelado) e TER (martech /
  // entregável pontual). Não é motivo pra descartar — é outro tipo de conversa.
  const ICP_CORE = 100000;          // piso do ICP core (EXECUTAR/recorrente pleno)
  const ICP_CONFORTAVEL = 200000;   // declarado acima disso → contradição é só ressalva
                                    // (porte desatualizado é a explicação mais provável)

  const PORTE_TETO_ANUAL = {
    'MEI': 81000,
    'MICRO EMPRESA': 360000,
    'ME': 360000,
    'EMPRESA DE PEQUENO PORTE': 4800000,
    'EPP': 4800000,
    'PEQUENO PORTE': 4800000,
  };

  function normalizarPorte(p) {
    return String(p || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  }

  // v9.5: empresa recém-aberta não teve exercício fiscal pra reenquadrar o porte.
  // O teto de ME/EPP é ANUAL — cobrar isso de quem abriu há 6 meses não faz sentido.
  function idadeEmpresaMeses(abertura) {
    if (!abertura) return null;
    const d = new Date(abertura);
    if (isNaN(d.getTime())) return null;
    return Math.floor((Date.now() - d.getTime()) / (30.44 * 86400000));
  }

  function checarCoerenciaPorte(porteReceita, fatMensalMin, capitalSocial, abertura) {
    const out = { checou: false, coerente: null, alerta: null, tetoMensal: null, porte: null, razao: null,
                  idadeMeses: idadeEmpresaMeses(abertura), empresaNova: false };
    if (out.idadeMeses != null && out.idadeMeses < 18) out.empresaNova = true;
    const p = normalizarPorte(porteReceita);
    if (!p || !fatMensalMin) return out;

    let teto = null;
    for (const [k, v] of Object.entries(PORTE_TETO_ANUAL)) {
      if (p.includes(normalizarPorte(k))) { teto = v; out.porte = k; break; }
    }
    // "DEMAIS" / "GRANDE" não tem teto — nada a checar
    if (!teto) { out.checou = true; out.coerente = true; return out; }

    out.checou = true;
    out.tetoMensal = teto / 12;
    const razao = fatMensalMin / out.tetoMensal;
    out.razao = razao;

    if (razao > 1.3) {   // 30% de tolerância pra porte desatualizado no limiar
      out.coerente = false;
      out.alerta = `declarado R$ ${fmtK(fatMensalMin)}/mês, mas a Receita registra ${out.porte} `
        + `(teto R$ ${fmtK(out.tetoMensal)}/mês) — ${razao.toFixed(razao >= 10 ? 0 : 1)}x acima do limite legal`;

      // v9.5: empresa nova → o porte é só o registro inicial, não indica receita
      if (out.empresaNova) {
        out.severidade = 'empresa_nova';
        out.alerta = `declarado R$ ${fmtK(fatMensalMin)}/mês vs. porte ${out.porte} na Receita, `
          + `MAS a empresa foi aberta há ${out.idadeMeses} ${out.idadeMeses === 1 ? 'mês' : 'meses'}`;
        out.nota = 'o teto de ME/EPP é ANUAL e o porte é o do registro inicial — empresa recém-aberta '
                 + 'não teve exercício fiscal pra reenquadrar. Isso NÃO indica faturamento inflado. '
                 + 'O que vale confirmar: se o faturamento declarado é realizado ou projetado';
      } else if (fatMensalMin >= ICP_CONFORTAVEL) {
        // faixa alta: mesmo caindo um degrau continua ICP → só ressalva
        out.severidade = 'ressalva';
        out.nota = 'mesmo que o faturamento real seja menor, a faixa provável segue dentro do ICP — '
                 + 'confirmar na ligação, mas não é motivo pra passar o lead';
      } else if (out.tetoMensal < ICP_CORE) {
        // faixa baixa + porte sugere ainda menor → pode sair do ICP
        out.severidade = 'risco_icp';
        out.nota = `porte registrado sugere faturamento abaixo de R$ ${fmtK(ICP_CORE)}/mês — `
                 + 'provavelmente FORA do ICP core. Não descarta o lead: segue qualificado '
                 + 'para SABER ou TER. Confirmar o faturamento antes de dimensionar a proposta';
      } else {
        out.severidade = 'ressalva';
        out.nota = 'confirmar faturamento real na ligação';
      }
    } else {
      out.coerente = true;
    }
    return out;
  }

  // Capital social irrisório para o porte declarado é sinal fraco, mas soma
  function checarCapital(capitalSocial, fatMensalMin) {
    if (!capitalSocial || !fatMensalMin) return null;
    const cap = Number(capitalSocial);
    if (!cap || cap <= 0) return null;
    // capital menor que 1 mês de faturamento declarado em operação grande
    if (fatMensalMin >= 400000 && cap < fatMensalMin * 0.25) {
      return `capital social de R$ ${cap.toLocaleString('pt-BR')} é baixo para operação de R$ ${fmtK(fatMensalMin)}/mês`;
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // COERÊNCIA DO CADASTRO (v9.4)
  // ═══════════════════════════════════════════════════════════════

  // Segmento declarado vs ramo investigado.
  // Divergir é comum (o campo costuma descrever o que o cliente QUER contratar),
  // mas precisa ficar VISÍVEL: significa que o cadastro é pouco confiável e que
  // o cálculo de margem não pode se apoiar nele.
  // Valores genéricos do formulário do LeadBroker → o que aceitam como ramo real.
  // "Varejo" bate com "comércio varejista"; "Serviço" bate com quase tudo que
  // não é indústria/comércio de produto.
  const SEGMENTO_FAMILIA = {
    varejo: /varej|comercio|loja|revend|atacad|distribuic|distribuidor|supermerc|mercad|otica|farmac|autopec|pneu|material de constru/,
    servico: /servic|consultor|assessor|advocac|contabil|clinic|medic|odontolog|estetic|salao|academia|escola|curso|educac|psicolog|nutric|fisioterap|veterinar|arquitetur|engenhar|manutenc|limpeza|logistic|transport|imobiliar|corretag|turismo|hotel|agencia de viagen|recrutament|treinament|seguro|contact center|bpo|software|saas|ti\b/,
    'food service': /restaurant|food|lanchonet|pizzari|hamburgu|pastel|bar\b|cafeteria|padari|confeitar|buffet|delivery/,
    industria: /industri|fabric|manufatur|metalurg|usinag|beneficiament|confecc/,
    imobiliaria: /imobiliar|corretag|incorporad|loteament|imovel|imoveis/,
    turismo: /turism|viagen|hotel|pousada|hospedag|agencia de viagen/,
    educacao: /educac|escola|curso|idioma|faculdad|universidad|ensino|treinament|infoproduto/,
    saude: /saud|clinic|medic|hospital|odontolog|dentist|laboratori|diagnostic|fisioterap|psicolog|nutric|veterinar/,
    tecnologia: /software|saas|erp|sistema|plataforma|aplicativo|ti\b|tecnolog|desenvolviment/,
    'marketing': /marketing|publicidad|propaganda|agencia|midia|comunicac|branding|trafego/,
    construcao: /constru|reforma|empreiteir|engenhar|arquitetur|material de constru/,
    beleza: /estetic|beleza|salao|barbear|cabelo|manicure|depilac|laser|harmonizac/,
    'e-commerce': /e-?commerce|loja virtual|marketplace|d2c|online/,
    automotivo: /automotiv|oficina|mecanic|autopec|pneu|concessionari|veicul|seminov/,
    agro: /agro|agricol|pecuar|fazend|lavour|gado|graos/,
  };

  function compararSegmento(ramoReal, segmentoDeclarado) {
    if (!ramoReal || !segmentoDeclarado) return null;
    const real = normalizarTexto(ramoReal);
    const decl = normalizarTexto(segmentoDeclarado);
    if (!real || !decl) return null;
    if (/^(outro|outros|n\/?a|nao informado|-)$/.test(decl)) return null;  // genérico demais pra comparar

    // 1) o segmento declarado tem família mapeada e o ramo real cai nela → coerente
    for (const [chave, re] of Object.entries(SEGMENTO_FAMILIA)) {
      if (decl.includes(chave) || normalizarTexto(chave).includes(decl)) {
        if (re.test(real)) return { divergente: false, via: 'família de segmento' };
      }
    }

    // 2) mesmo subsegmento do benchmark → coerente
    const subRamo = classificarMargem(ramoReal);
    const subSeg = classificarMargem(segmentoDeclarado);
    if (subRamo && subSeg && subRamo.nome === subSeg.nome) {
      return { divergente: false, via: 'mesmo subsegmento' };
    }

    // 3) radical de 5 letras em comum (varejo ↔ varejista, industria ↔ industrial)
    const radicais = s => normalizarTexto(s).split(/\s+/)
      .filter(w => w.length >= 5).map(w => w.slice(0, 5));
    const rr = new Set(radicais(ramoReal));
    if (radicais(segmentoDeclarado).some(r => rr.has(r))) {
      return { divergente: false, via: 'radical em comum' };
    }

    return {
      divergente: true,
      declarado: segmentoDeclarado,
      real: ramoReal,
      subDeclarado: subSeg ? subSeg.nome : null,
      subReal: subRamo ? subRamo.nome : null,
    };
  }

  // E-mail genérico (@gmail etc) é normal em negócio muito pequeno, mas fica
  // incoerente conforme o faturamento declarado cresce: empresa formalizada
  // faturando centenas de milhares quase sempre tem domínio próprio.
  function checarEmailPorte(emailInfo, faturamentoMin) {
    if (!emailInfo || !emailInfo.valido || emailInfo.corporativo !== false) return null;
    if (!faturamentoMin) return null;

    if (faturamentoMin >= 400000) {
      return {
        nivel: 'alto',
        texto: `e-mail @${emailInfo.dominio} para faturamento declarado de R$ ${fmtK(faturamentoMin)}+/mês — `
             + 'empresa formalizada nesse porte quase sempre tem domínio próprio. '
             + 'Pode indicar faturamento inflado, ou que o contato usou e-mail pessoal',
      };
    }
    if (faturamentoMin >= 100000) {
      return {
        nivel: 'medio',
        texto: `e-mail @${emailInfo.dominio} com faturamento declarado de R$ ${fmtK(faturamentoMin)}+/mês — `
             + 'sem domínio próprio nesse porte é incomum. SDR confirma',
      };
    }
    return { nivel: 'baixo', texto: `e-mail @${emailInfo.dominio} — normal nesse porte, sem domínio próprio` };
  }

  function renderBoxes(entry) {
    const f = calcularFarol(entry);
    entry.farol = f;
    // o farol é a informação mais importante do card — nada pode impedir que
    // ele apareça, nem erro no render dos boxes nem nos dados encontrados.
    try { repintarFarol(entry, f.cor, !!f.conc); } catch (e) { console.warn('[V4] farol:', e); }
    // v17.0: sinal de porte maior que o declarado vai ACIMA dos boxes — é o que
    // pode fazer você pagar mais que o mercado com convicção.
    try {
      const pm = entry.porteMaior;
      const wrapPM = entry.card.querySelector('.v4-portemaior');
      if (pm && wrapPM) {
        wrapPM.style.display = '';
        wrapPM.innerHTML = `
          <div class="v4-pm-tit">⚡ SINAIS DE PORTE MAIOR QUE O DECLARADO</div>
          <div class="v4-pm-sinais">${pm.sinais.map(s => esc(s)).join(' &nbsp;·&nbsp; ')}</div>
          <div class="v4-pm-nota">declarado ${esc(pm.declarado || pm.faixaAtual)} — confirme o faturamento na abertura</div>`;
      } else if (wrapPM) {
        wrapPM.style.display = 'none';
        wrapPM.innerHTML = '';
      }
    } catch (e) {}

    const ordem = ['concorrente', 'empresa', 'decisor', 'margem'];
    const alvo = entry.card.querySelector('.v4-boxes');
    if (!alvo) return;
    alvo.innerHTML = ordem.map(k => {
      const b = f.boxes[k];
      const ic = b.cor === 'verde' ? '✓' : b.cor === 'concorrente' ? '🚨' : b.cor === 'vermelho' ? '✕' : '⚠';
      return `<div class="v4-box ${b.cor}">
          <div class="v4-box-lbl">${ic} ${esc(b.titulo)}</div>
          <div class="v4-box-txt">${esc(b.txt)}</div>
          ${b.sub ? `<div class="v4-box-sub">${esc(b.sub)}</div>` : ''}
        </div>`;
    }).join('');
    // v17.12: o farol passa a ser derivado do que ESTÁ NA TELA, depois dos
    // boxes renderizados. Antes ele era pintado a partir do cálculo e os boxes
    // desenhados em seguida — e por algum caminho que quatro investigações não
    // reproduziram, os dois divergiam ("GO" com box amarelo).
    //
    // Lendo as cores de volta do DOM, divergir vira impossível: se o box está
    // amarelo na tela, o farol lê amarelo. Não há estado intermediário.
    try {
      const naTela = [...alvo.querySelectorAll('.v4-box')].map(el =>
        el.classList.contains('concorrente') ? 'concorrente'
        : el.classList.contains('vermelho') ? 'vermelho'
        : el.classList.contains('amarelo') ? 'amarelo'
        : el.classList.contains('verde') ? 'verde' : null).filter(Boolean);

      if (naTela.length === 4) {
        const conc = naTela.includes('concorrente');
        const corReal = conc ? 'vermelho'
                       : naTela.includes('vermelho') ? 'vermelho'
                       : naTela.includes('amarelo') ? 'amarelo' : 'verde';
        if (corReal !== f.cor || conc !== !!f.conc) {
          console.warn('[V4] farol corrigido pelos boxes na tela:', f.cor, '→', corReal);
          f.cor = corReal;
          f.conc = conc;
          f.rot = conc ? 'CONCORRENTE' : corReal === 'vermelho' ? 'STOP'
                : corReal === 'amarelo' ? 'CAUTION' : 'GO';
          f.luz = conc ? '🚨' : corReal === 'vermelho' ? '🔴'
                : corReal === 'amarelo' ? '🟡' : '🟢';
        }
        repintarFarol(entry, f.cor, !!f.conc);
      }
    } catch (e) { console.warn('[V4] derivação do farol:', e); }

    try { renderDados(entry); }
    catch (e) { console.warn('[V4] renderDados falhou (farol já pintado):', e); }
  
    // ═══ AUTOVERIFICAÇÃO (v23.3) ═══
    // O farol e os boxes já saem do mesmo cálculo, mas essa divergência voltou
    // três vezes (v16.4, v17.12, v18.3) por caminhos diferentes — o último foi
    // o INSTITUTO PRESBITERIANO, GO com decisor e margem amarelos.
    //
    // Em vez de confiar no cálculo, aqui a gente LÊ as cores que ficaram na
    // tela e corrige o farol a partir delas. Se o box está amarelo no card,
    // o farol lê amarelo. Não há como divergir.
    try {
      const pintados = [...entry.card.querySelectorAll('.v4-box')].map(el => {
        for (const c of ['concorrente', 'vermelho', 'amarelo', 'verde']) {
          if (el.classList.contains(c)) return c;
        }
        return null;
      }).filter(Boolean);

      if (pintados.length) {
        const real = pintados.includes('concorrente') ? 'vermelho'
          : pintados.includes('vermelho') ? 'vermelho'
          : pintados.includes('amarelo') ? 'amarelo'
          : 'verde';
        if (real !== f.cor) {
          console.warn('[V4] farol divergiu dos boxes:', f.cor, '→', real,
                       '·', entry.extracted && entry.extracted.nomeEmpresa);
          const conc = pintados.includes('concorrente');
          f.cor = real;
          f.rot = conc ? 'CONCORRENTE' : real === 'vermelho' ? 'STOP'
                : real === 'amarelo' ? 'CAUTION' : 'GO';
          f.luz = conc ? '🚨' : real === 'vermelho' ? '🔴'
                : real === 'amarelo' ? '🟡' : '🟢';
          f.conc = conc;
          entry.farol = f;
          repintarFarol(entry, real, conc);
        }
      }
    } catch (e) { console.warn('[V4] autoverificação do farol:', e); }
}

  function fmtCnpj(c) {
    const d = String(c || '').replace(/\D/g, '');
    return d.length === 14 ? `${d.slice(0,2)}.${d.slice(2,5)}.${d.slice(5,8)}/${d.slice(8,12)}-${d.slice(12)}` : String(c || '');
  }

  function renderDados(entry) {
    const w = entry.card.querySelector('.v4-dadoswrap');
    if (!w) return;
    const m = entry.m2 || entry.m1 || {};
    const e = entry.oficial;
    const ex = entry.extracted;
    const L = [];

    if (e && e.cnpj) {
      L.push(['CNPJ', `${esc(fmtCnpj(e.cnpj))} · ${esc(e.situacao || '?')}`
        + (e.abertura ? ` desde ${String(e.abertura).slice(0,4)}` : '')
        + (e.porte ? ` · ${esc(String(e.porte).toLowerCase())}` : '')]);
      if (e.nome_fantasia && normalizarTexto(e.nome_fantasia) !== normalizarTexto(e.razao_social || '')) {
        L.push(['Nome fantasia', esc(e.nome_fantasia)
          + (entry.nomeBate === 'nome fantasia'
             ? ' <span class="v4-tag-ok">é o nome do lead</span>' : '')]);
      }
      if (e.cnae) L.push(['CNAE', esc(e.cnae) + ' <span class="v4-tag-ok">Receita</span>']);
      // v16.0: natureza jurídica — em individual, a razão social é o dono
      const nt = entry.natureza;
      if (nt && nt.texto) {
        L.push(['Natureza', esc(nt.texto)
          + (nt.individual && nt.contatoEhDono
              ? ' <span class="v4-tag-ok">o contato é o titular</span>' : '')
          + (nt.filial ? ' <span class="v4-tag-al">é filial — a matriz é outra</span>' : '')]);
      }
      if (entry.alertaCapital) L.push(['Capital', esc(entry.alertaCapital)]);
      // v17.1: quando a razão social diz mais que o CNAE, mostra os dois
      const cvr = entry.cnaeVsRazao;
      if (cvr) {
        L.push(['Razão social', esc(cvr.razao)
          + '<br><span style="color:#FBBF24">a razão social cita ' + esc(cvr.extras.join(', '))
          + '</span><span style="color:#8A8A8A">, que não está no CNAE — a empresa faz mais de uma coisa</span>']);
      }
    } else if (m.cnpj_descoberto) {
      // v14.4: a IA às vezes devolve o CNPJ com ressalva embutida — "83.144.733/
      // 0001-00 (inferido pelas filiais, não explicitamente encontrado)". Isso
      // não é um CNPJ: é um palpite. Só aceita o número limpo.
      const bruto = String(m.cnpj_descoberto);
      const digitos = bruto.replace(/\D/g, '');
      const inferido = /inferid|provavel|prov[áa]vel|presumid|estimad|talvez|possivelmente|n[ãa]o (explicit|confirmad|encontrad)/i.test(bruto);
      if (digitos.length === 14 && !inferido) {
        L.push(['CNPJ', esc(fmtCnpj(digitos)) + ' <span class="v4-tag-al">achado na busca, não consultado</span>']);
      } else {
        L.push(['CNPJ', '<span style="color:#FBBF24">não confirmado</span>'
          + '<span style="color:#8A8A8A"> — a IA sugeriu um número sem achar a fonte</span>']);
      }
    }

    if (ex.faturamento) {
      const cp = entry.coerenciaPorte;
      let tag = '<span class="v4-tag-al">declarado, não confirmado</span>';
      let nota = '';
      if (cp && cp.checou && cp.coerente === true) {
        tag = '<span class="v4-tag-ok">confere com a Receita</span>';
      } else if (cp && cp.coerente === false) {
        tag = `<span class="v4-tag-al">${cp.severidade === 'empresa_nova' ? 'empresa recém-aberta' : 'não bate com a Receita'}</span>`;
        if (cp.alerta) nota = `<div style="color:#8A8A8A;font-size:11px;margin-top:2px">${esc(cp.alerta)}</div>`;
      }
      L.push(['Faturamento', esc(ex.faturamento) + ' ' + tag + nota]);
    }

    const ramoIA = (entry.m2 && entry.m2.ramo_real) || m.ramo_aparente;
    if (ramoIA) {
      // v17.10: o campo Segmento do formulário é uma lista curta e o dono marca
      // o que parece mais próximo. Divergir é o normal, não uma contradição —
      // então a nota é neutra, em cinza, e não amarela.
      const div = entry.divSegmento && entry.divSegmento.divergente;
      L.push(['Ramo real', esc(ramoIA)
        + (div ? ` <span style="color:#8A8A8A">· no formulário marcou "${esc(ex.segmento)}"</span>` : '')]);
    } else if (ex.segmento) {
      L.push(['Ramo', `não confirmado · formulário diz "${esc(ex.segmento)}"`]);
    }

    if (e && (e.qsa || []).length) {
      const q = entry.qsaMatch, par = entry.parentesco;
      let t = e.qsa.map(s => esc(s.nome)).join(' · ');
      if (q) t += ` — <span style="color:#86EFAC">contato é ${esc(q.socio.nome)}</span>`;
      else if (par) t += ` — <span style="color:#FCD34D">sobrenome ${esc(par.sobrenomes)} coincide</span>`;
      // v16.9: o box de decisor pode ter confirmado por outra via (evidência que
      // cita o CNPJ). Se confirmou, a linha de sócios não pode dizer o contrário.
      else if (entry.boxes && entry.boxes.decisor && entry.boxes.decisor.cor === 'verde'
               && /é sócio/i.test(entry.boxes.decisor.txt || '')) {
        t += ' — <span style="color:#86EFAC">contato confirmado como sócio</span>';
      }
      // v16.5: sem contato no lead não dá pra dizer que ele "não está no QSA".
      // São coisas diferentes: contato ausente ≠ contato que não é sócio.
      else if (!ex.nomeContato) t += ' <span style="color:#8A8A8A">— o lead não trouxe o contato</span>';
      else t += ' — contato não está no QSA';
      L.push(['Sócios', t]);
    }

    // v14.14: quando o QSA da Receita já confirmou o sócio, a busca da IA não
    // importa mais — e mostrar "não há evidências de X como sócia" logo abaixo
    // de "é sócio · confirmado na Receita" só contradiz o card.
    const qsaOk = entry.qsaMatch && (entry.qsaMatch.confianca === 'alta' || entry.qsaMatch.confianca === 'media');
    if (!qsaOk) {
      const dec = [];
      if (m.decisor_papel) dec.push(esc(m.decisor_papel));
      if (m.decisor_evidencia) dec.push(`<span style="color:#888">${esc(m.decisor_evidencia)}</span>`);
      if (dec.length) L.push(['Busca decisor', dec.join('<br>')]);
    }

    const links = [];
    if (m.site) links.push(`<a href="${esc(m.site)}" target="_blank" rel="noopener">${esc(String(m.site).replace(/^https?:\/\//,''))}</a>`);
    if (m.instagram) links.push(esc(m.instagram));
    if (links.length) L.push(['Online', links.join(' · ')]);
    const en2 = entry.enriq;
    if (en2) {
      const ic = v => v === true ? '<span style="color:#4ADE80">✓</span>'
                    : v === false ? '<span style="color:#F87171">✕</span>'
                    : '<span style="color:#666">—</span>';
      const alerta = en2.hipotetico
        ? '<br><span style="color:#FBBF24">⚠ o texto é majoritariamente hipotético: '
          + `${en2.condicionais} seções usam "caso seja" / "se for"</span>` : '';
      L.push(['LeadBroker',
        `${ic(en2.empresaConfirmada)} empresa &nbsp; ${ic(en2.decisorConfirmado)} decisor &nbsp; ${ic(en2.socioEncontrado)} sócio`
        + ` <span style="color:#8A8A8A">· ${en2.negativas}/${en2.secoes.length} seções sem confirmação</span>`
        + alerta]);
    }

    const oeD = entry.outrasEmpresas;
    if (oeD && oeD.lista.length) {
      const itens = oeD.lista.slice(0, 4).map(e =>
        `${esc(e.nome)}${e.cidade ? ` <span style="color:#8A8A8A">· ${esc(e.cidade)}</span>` : ''}`
        + `${e.papel ? ` <span style="color:#8A8A8A">(${esc(e.papel)})</span>` : ''}`
        + (e.e_a_do_lead === true ? ' <span class="v4-tag-ok">é a do lead</span>' : '')
      ).join('<br>');
      L.push([oeD.total > 1 ? `Negócios (${oeD.total})` : 'Negócio', itens]);
      if (oeD.descartadas && oeD.descartadas.length) {
        L.push(['', `<span style="color:#8A8A8A">${oeD.descartadas.length} homônimo(s) descartado(s) `
          + 'por não ter ligação com esta empresa</span>']);
      }
    }

    const va = entry.vinculoAgencia;
    if (va) {
      L.push(['⚠ Agência?', va.provas.map(p => esc(p.txt)).join('<br>')
        + '<br><span style="color:#8A8A8A">pode ser agência intermediando o cliente — confirme na abertura</span>']);
    }

    if (ex.email) {
      const ei2 = ex.emailInfo || {};
      const pista = ei2.nomeExtraido && !ex.nomeContato
        ? ` <span class="v4-tag-al">sugere "${esc(cap(ei2.nomeExtraido))}"</span>` : '';
      L.push(['E-mail', esc(ex.email) + pista]);
    }

    if (entry.margemDivergente) {
      const d = entry.margemDivergente;
      L.push(['⚠ Atividade', `CNAE registra <b>${esc(d.cnae.nome)}</b> (margem ${esc(d.cnae.rot)}), `
        + `mas a investigação achou <b>${esc(d.real.nome)}</b> (margem ${esc(d.real.rot)})`
        + '<br><span style="color:#8A8A8A">CNAE desatualizado é comum em negócio digital — pergunte o que fazem hoje</span>']);
    }

    // v16.0: contato do lead × cadastro público
    const cc2 = entry.contatoCadastro;
    if (cc2) {
      const item = (rot, v) => v ? `${rot}: ${v === 'confere'
        ? '<span style="color:#4ADE80">confere</span>'
        : '<span style="color:#FBBF24">diverge</span>'}` : '';
      const partes2 = [item('telefone', cc2.tel), item('e-mail', cc2.email), item('cidade', cc2.cidade)].filter(Boolean);
      if (partes2.length) {
        L.push(['Cadastro', partes2.join(' &nbsp;·&nbsp; ')
          + (cc2.divergencias >= 2
            ? '<br><span style="color:#FBBF24">⚠ o contato do lead não bate com o cadastro — pode ser intermediário</span>'
            : '')]);
      }
    }

    if (entry.cnpjErrado) {
      L.push(['⚠ CNPJ', esc(entry.cnpjErrado.texto)
        + '<br><span style="color:#8A8A8A">os dados da Receita foram descartados — '
        + 'seriam de outra empresa</span>']);
    }
    if (entry.cnpjConfirmado) {
      L.push(['CNPJ', '<span class="v4-tag-ok">confere com o cadastro do lead</span>']);
    }

    if (entry.marcaNacional) {
      L.push(['⚠ Homônimo', esc(entry.marcaNacional.texto)]);
    }

    if (entry.iniciais) {
      L.push(['⚠ Nome', esc(entry.iniciais.texto)
        + ' <span style="color:#8A8A8A">— procure empresas no CPF/nome dele</span>']);
    }
    if (ex.regiao) L.push(['DDD', `${ex.ddd} · ${esc(ex.regiao.texto)}`]);
    if (entry.emailPorte && entry.emailPorte.nivel === 'alto') {
      L.push(['E-mail', esc(entry.emailPorte.texto)]);
    }

    w.innerHTML = L.length ? `<div class="v4-dados"><div class="v4-dados-lbl">Dados encontrados</div>
      <table>${L.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('')}</table></div>` : '';
  }

  // v14.0: empresas no nome do contato. Dono de CNPJ é decisor por definição —
  // tem capital, decide sozinho e conhece custo de aquisição. Um contato com
  // negócio próprio vale MAIS que um contato sem rastro, mesmo que a empresa
  // achada não seja exatamente a do lead.
  // v14.5: em vez de detectar homônimo pelos sintomas (estados espalhados,
  // nomes conflitantes), cada empresa achada tem que PROVAR vínculo com a
  // empresa do lead. Sem prova, sai da lista.
  //
  // Só o nome bater não prova nada: "Mateus Sousa" devolveu 4 pessoas
  // diferentes, e nenhuma tinha ligação com a Igarashi.
  // v17.7: "ODONTOLOGIA", "PADARIA", "CONSTRUÇÃO" são o RAMO, não o nome da
  // empresa. Caso PROSPERA: o lead se chamava "ODONTOLOGIA" e casou com
  // "PROSPERA ODONTOLOGIA E SAUDE LTDA" em outra cidade, de outro dono.
  const PALAVRA_DE_RAMO = /^(odontolog\w*|dent[áa]ri\w*|medic\w*|cl[íi]nic\w*|sa[úu]de|est[ée]tic\w*|farm[áa]ci\w*|drogari\w*|padari\w*|confeitari\w*|panificador\w*|restaurant\w*|lanchonet\w*|pizzari\w*|churrascari\w*|mercad\w*|supermercad\w*|minimercad\w*|merceari\w*|constru\w*|engenhari\w*|arquitetur\w*|advocaci\w*|contabil\w*|consultori\w*|assessori\w*|transport\w*|log[íi]stic\w*|distribuidor\w*|varej\w*|com[ée]rci\w*|ind[úu]stri\w*|f[áa]bric\w*|servi[çc]\w*|solu[çc]\w*|tecnolog\w*|inform[áa]tic\w*|digital|marketing|publicidad\w*|educa[çc]\w*|escol\w*|cursos?|academi\w*|fitness|salao|barbeari\w*|petshop|veterin[áa]ri\w*|imobili[áa]ri\w*|corretor\w*|seguros?|autopec\w*|mec[âa]nic\w*|oficin\w*|ve[íi]cul\w*|motos?|pneus?|moveis?|m[óo]veis|decora[çc]\w*|confec[çc]\w*|moda|calcad\w*|cal[çc]ad\w*|joalheri\w*|[óo]tic\w*|papelari\w*|livrari\w*|energi\w*|solar|telecom\w*|internet|eventos?|turismo|viagens?|hotel|pousad\w*|limpez\w*|seguran[çc]\w*|agro\w*|agricultur\w*|pecuari\w*|aliment\w*)$/i;

  function provarVinculo(e, entry) {
    // v19.9: já provado pelo prefixo do CNPJ — não há o que discutir
    if (e && e._peloCnpj && e._prova) return e._prova;
    const ex = entry.extracted;
    const of = entry.oficial || {};
    // v17.10: no Brasil quase toda PME tem razão social com o nome do dono e
    // opera com outro nome. "H-NAY Soluções" e "Juhad W Al Chaar Serviços - ME"
    // podem ser a mesma empresa. O contato quase sempre escreve o FANTASIA.
    const nomeEmp = normalizarTexto((e.nome || '') + ' ' + (e.nome_fantasia || e.fantasia || ''));
    const cidadeEmp = normalizarTexto(e.cidade || '').split(/[,\/]/)[0].trim();

    // 1) a própria IA afirmou que é a do lead
    if (e.e_a_do_lead === true) return { forca: 'definitiva', prova: 'é a empresa do lead' };

    // 2) CNPJ igual ao do lead
    const cnpjE = String(e.cnpj || '').replace(/\D/g, '');
    const cnpjL = String(of.cnpj || '').replace(/\D/g, '');
    if (cnpjE && cnpjL && cnpjE.slice(0, 8) === cnpjL.slice(0, 8)) {
      return { forca: 'definitiva', prova: 'mesma raiz de CNPJ' };
    }

    // 3) sobrenome do contato bate com sócio no QSA do lead.
    // v15.2: isso prova PARENTESCO com o sócio, não que a empresa achada seja a
    // do lead. Caso PADARIA: Willian Carvalho tinha 3 homônimos em estados
    // diferentes e o parentesco com a sócia Dayane Carvalho os transformava em
    // "dono de 3 empresas". Só vale se a empresa achada também tiver o sobrenome.
    if (entry.parentesco) {
      const sobr = String(entry.parentesco.sobrenomes || '').split(/[,;]/).map(s => normalizarTexto(s.trim()));
      if (sobr.some(s => s && nomeEmp.includes(s))) {
        return { forca: 'forte', prova: `sobrenome ${entry.parentesco.sobrenomes} na razão social e no QSA` };
      }
    }

    // v17.7: o nome DISTINTIVO DA EMPRESA na razão social é prova independente
    // do nome do contato ser comum. "ALPATECH" em "ALPATECH INDUSTRIA DE
    // PLASTICOS" identifica a empresa mesmo com o contato chamado Daniel Souza.
    // Palavra de ramo (ODONTOLOGIA, PADARIA) não vale — está em milhares.
    const distEmpresa = partesNome(ex.nomeEmpresa || '')
      .filter(p => p.length > 3 && parteDistintiva(p) && !PALAVRA_DE_RAMO.test(p));
    const nomeEmpresaNaRazao = distEmpresa.length && distEmpresa.some(p => nomeEmp.includes(p));
    if (nomeEmpresaNaRazao) {
      // v17.10: dizer QUAL campo casou — razão social ou nome fantasia
      const soRazao = normalizarTexto(e.nome || '');
      const naRazao = distEmpresa.some(p => soRazao.includes(p));
      return {
        forca: 'forte',
        prova: naRazao ? 'nome do lead aparece na razão social'
                       : 'nome do lead é o nome fantasia da empresa',
      };
    }

    // 4) mesma cidade do lead E o nome do contato é distintivo
    const cidadeL = normalizarTexto(ex.cidade || (ex.regiao ? ex.regiao.praca : ''));
    const distintivo = partesNome(ex.nomeContato || '').some(p => parteDistintiva(p));
    if (cidadeL && cidadeEmp && cidadeEmp === cidadeL) {
      return distintivo
        ? { forca: 'forte', prova: `mesma cidade (${e.cidade})` }
        : { forca: 'fraca', prova: `mesma cidade, mas nome comum` };
    }

    return null;   // só o nome da pessoa bate — não prova nada
  }

  function avaliarOutrasEmpresas(entry) {
    const m = entry.m2 || entry.m1 || {};
    const ex = entry.extracted || {};

    // v19.9: se o cadastro trouxe dígitos do CNPJ e alguma empresa achada no
    // nome do contato bate com eles, ela é A empresa do lead — independente de
    // cidade, nome ou qualquer outro critério. Caso ANTONIO BOMFIM: a
    // investigação achou 4 empresas dele e não conferiu o CNPJ de nenhuma
    // contra o 68777 que estava no cadastro.
    const prefixo = String(ex.cnpjParcial || '').replace(/\D/g, '');
    if (prefixo.length >= 4 && Array.isArray(m.outras_empresas)) {
      for (const e of m.outras_empresas) {
        const c = String(e && e.cnpj || '').replace(/\D/g, '');
        if (c.length === 14 && c.startsWith(prefixo.slice(0, Math.min(prefixo.length, 8)))) {
          e._prova = { forca: 'definitiva', prova: `CNPJ bate com o cadastro do lead (${fmtPrefixo(prefixo)})` };
          e._peloCnpj = true;
        }
      }
    }
    const bruta = Array.isArray(m.outras_empresas) ? m.outras_empresas.filter(e => e && e.nome) : [];
    if (!bruta.length) return null;

    const comProva = [], semProva = [];
    for (const e of bruta) {
      const v = provarVinculo(e, entry);
      if (v && v.forca !== 'fraca') comProva.push({ ...e, _prova: v });
      else semProva.push(e);
    }

    let lista = comProva;

    // v19.9: se ALGUMA empresa bateu pelo prefixo do CNPJ, ela é a do lead e as
    // outras são homônimas — mesmo que o nome bata. O CNPJ é prova de
    // identidade; o nome é só indício. Caso ANTONIO BOMFIM: quatro empresas com
    // o nome dele, uma só com o CNPJ do cadastro.
    const peloCnpj = lista.filter(e => e._peloCnpj);
    if (peloCnpj.length) {
      semProva.push(...lista.filter(e => !e._peloCnpj));
      lista = peloCnpj;
    }

    const aDoLead = lista.find(e => e._prova.forca === 'definitiva') || null;

    return {
      lista, descartadas: semProva,
      total: lista.length, totalBruto: bruta.length,
      aDoLead,
      // dono de verdade: pelo menos uma empresa provou vínculo E é papel de sócio
      // v17.7: o papel às vezes vem com o nome de OUTRA pessoa —
      // "Sócio-Administrador (Marcelo Jesuino dos Santos)" com o contato sendo
      // Richard Nobre. Isso não confirma o contato como dono.
      ehDono: lista.some(e => {
        const papel = String(e.papel || '');
        if (!/s[óo]ci|administrador|titular|propriet|dono/i.test(papel)) return false;
        const entre = papel.match(/\(([^)]{6,})\)/);
        if (entre && ex.nomeContato) {
          const pc = partesNome(ex.nomeContato).filter(p => p.length > 2);
          const pp = normalizarTexto(entre[1]).split(/\s+/);
          if (pc.length && !pc.some(p => pp.includes(p))) return false;
        }
        return true;
      }),
      // homônimo: a IA trouxe empresas, mas nenhuma se liga ao lead
      homonimos: lista.length === 0 && semProva.length > 0,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // CONCORRÊNCIA POR VÍNCULO DO CONTATO (v14.2)
  // Caso real: lead "BANCO HR DIGITAL" (um banco, não é agência), mas a contato
  // Letycia usa @nucleopropaganda.com.br e os dois negócios achados no nome dela
  // eram "HR Agência de Publicidade" e "HR Marketing". Três sinais de agência —
  // e o box dizia "não é agência" em verde, porque ninguém cruzava os dados.
  //
  // Não é veto: a agência pode estar preenchendo o formulário para um cliente.
  // Mas o SDR precisa saber com quem vai falar antes de ligar.
  // ═══════════════════════════════════════════════════════════════
  const SINAL_AGENCIA = /ag[êe]ncia|publicidade|propaganda|marketing|m[íi]dia|comunica[çc][ãa]o|assessoria de imprensa|growth|performance|inbound|digital\s?(house|lab)|social\s?media/i;

  // v16.7: "Soluções", "Comércio", "Digital" aparecem em milhares de razões
  // sociais que nada têm a ver com marketing. O nome sozinho não prova —
  // a "Lse Soluções e Comércio" acendeu alerta de agência sendo consultoria
  // de energia. Agora o nome só conta com o RAMO confirmando.
  const NOME_FORTE_AGENCIA = /ag[êe]ncia (de )?(publicidade|propaganda|marketing|comunica)|assessoria de imprensa|marketing digital|social ?media|growth (agency|marketing)/i;

  function checarVinculoAgencia(entry) {
    const ex = entry.extracted;
    const provas = [];

    const oe = entry.outrasEmpresas;
    if (oe) {
      const todas = [...(oe.lista || []), ...(oe.descartadas || [])];
      for (const e of todas) {
        const nome = String(e.nome || '');
        const ramo = soAfirmativo(String(e.ramo || ''));   // v17.6
        // o ramo descrito é prova; o nome só vale se for inequívoco
        const porRamo = !!ramo && SINAL_AGENCIA.test(ramo);
        const porNome = NOME_FORTE_AGENCIA.test(nome);
        if (porRamo || porNome) {
          provas.push({ tipo: 'empresa', txt: nome + (e.cidade ? ` · ${e.cidade}` : '') });
        }
      }
    }

    // domínio do e-mail do contato — este é sinal forte, o domínio é escolhido
    const ei = ex.emailInfo;
    if (ei && ei.corporativo && SINAL_AGENCIA.test(String(ei.dominio || ''))) {
      provas.push({ tipo: 'email', txt: `e-mail @${ei.dominioFull}` });
    }

    // 3) domínio do e-mail não bate com o site da empresa do lead
    const m = entry.m2 || entry.m1 || {};
    const siteLead = normalizarTexto(String(m.site || '')).replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
    const domContato = ei && ei.dominioFull ? normalizarTexto(ei.dominioFull) : '';
    const dominioDiferente = !!(siteLead && domContato && !siteLead.includes(domContato.split('.')[0])
                                && !domContato.includes(siteLead.split('.')[0]));

    if (!provas.length) return null;
    return { provas, dominioDiferente };
  }

  // ═══════════════════════════════════════════════════════════════
  // ENRIQUECIMENTO DO LEADBROKER (v15.0)
  // O LB passou a mandar um texto longo com seções em negrito. O problema é o
  // formato: 400 palavras onde o sinal que decide fica enterrado no meio, e
  // boa parte é condicional ("caso seja", "se for", "provável").
  //
  // Caso real — VEREFE: o texto descreve em detalhe uma empresa de tecnologia
  // e BPO... nos EUA. E no meio diz "Se for a empresa brasileira, nenhuma
  // operação real foi encontrada". Isso é um STOP vestido de parágrafo.
  // ═══════════════════════════════════════════════════════════════
  const ENRIQ_SECOES = [
    { re: /cadastro empresarial/i,        chave: 'cadastro',   rot: 'Cadastro' },
    { re: /atividade e opera/i,           chave: 'atividade',  rot: 'Atividade' },
    { re: /decisor/i,                     chave: 'decisor',    rot: 'Decisor' },
    { re: /s[óo]cios? e pessoas.?chave/i, chave: 'socios',     rot: 'Sócios' },
    { re: /presen[çc]a digital/i,         chave: 'digital',    rot: 'Presença digital' },
    { re: /localiza[çc][ãa]o e contato/i, chave: 'local',      rot: 'Localização' },
    { re: /concorrentes/i,                chave: 'concorrentes', rot: 'Concorrentes' },
    { re: /sinais de timing/i,            chave: 'timing',     rot: 'Timing' },
    { re: /abordagem sugerida/i,          chave: 'abordagem',  rot: 'Abordagem' },
  ];

  // linguagem de CONFIRMAÇÃO — o LB achou mesmo
  const ENRIQ_POSITIVO = /\b(confirmad[oa]s?|ativo|identificad[oa]s?|localizad[oa]s?|encontrad[oa]s?|existente|mapead[oa]s?|p[úu]blicos? confirmad)\b/i;
  const ENRIQ_CONF_ALTA = /alta confian[çc]a|confian[çc]a alta|\d+ fontes/i;

  // linguagem que indica que NADA foi confirmado
  const ENRIQ_NEGATIVO = /n[ãa]o (confirmad|localizad|encontrad|identificad|h[áa] (registro|evid|indic)|foi poss[íi]vel|houve confirma)|aus[êe]ncia de|nenhum[ao]? (opera|s[óo]cio|administrador|registro|evid)|sem (confirma|evid|indica[çc][ãa]o|registro)/i;
  // linguagem condicional: o que vem depois é hipótese, não fato
  const ENRIQ_CONDICIONAL = /\b(caso seja|se for|prov[áa]vel|provavelmente|poss[íi]vel|possivelmente|sugerindo|indica que pode|talvez|hip[óo]tese)\b/i;
  const ENRIQ_CONF_BAIXA = /confian[çc]a (m[ée]dia|baixa)/i;

  function lerEnriquecimento(texto) {
    if (!texto) return null;
    const bruto = String(texto).trim();
    if (bruto.length < 60) return null;

    // separa por "**Título.**" ou "Título." em negrito
    const partes = bruto.split(/\*\*(.+?)\*\*/).filter(x => x.trim());
    const secoes = [];
    for (let i = 0; i < partes.length; i++) {
      const cand = partes[i].trim();
      const def = ENRIQ_SECOES.find(s => s.re.test(cand) && cand.length < 60);
      if (def && partes[i + 1]) {
        secoes.push({ ...def, texto: partes[i + 1].trim() });
        i++;
      }
    }
    // sem marcação de negrito: tenta por "Palavra." no início de frase
    if (!secoes.length) {
      for (const def of ENRIQ_SECOES) {
        const m = bruto.match(new RegExp(`(?:^|[.!?]\\s+)(${def.re.source})[.:]\\s+([^]*?)(?=(?:[.!?]\\s+[A-ZÀ-Ý][a-zà-ÿ]+[.:]\\s)|$)`, 'i'));
        if (m && m[2]) secoes.push({ ...def, texto: m[2].trim() });
      }
    }
    if (!secoes.length) return null;

    // mede a qualidade de cada seção
    // v15.1: avaliar por ORAÇÃO, não pela seção inteira. "não confirmado" contém
    // "confirmad" e contava como positivo; "nenhum sócio encontrado" idem.
    // Cada oração só é positiva se tiver termo de confirmação E nenhuma negação
    // ou condicional dentro dela.
    function avaliarOracoes(txt) {
      const oracoes = String(txt).split(/[;.]|(?:,\s*(?=(?:mas|por[ée]m|embora|contudo|todavia)\b))/i)
        .map(o => o.trim()).filter(o => o.length > 8);
      let p = 0, n = 0, c = 0;
      for (const o of oracoes) {
        const temNeg = ENRIQ_NEGATIVO.test(o);
        const temCond = ENRIQ_CONDICIONAL.test(o);
        if (temNeg) { n++; continue; }
        if (temCond) { c++; continue; }
        if (ENRIQ_POSITIVO.test(o)) p++;
      }
      return { p, n, c, total: oracoes.length };
    }

    let neg = 0, cond = 0, pos = 0;
    for (const s of secoes) {
      const a = avaliarOracoes(s.texto);
      s.oracoes = a;
      s.negativo = a.n > 0;
      s.positivo = a.p > 0;
      s.condicional = a.c > 0;
      s.confBaixa = ENRIQ_CONF_BAIXA.test(s.texto);
      s.confAlta = ENRIQ_CONF_ALTA.test(s.texto);
      // a seção pende para o lado que tiver mais orações
      if (a.n > a.p) neg++;
      else if (a.p > a.n) pos++;
      if (a.c > 0) cond++;
    }

    const pega = c => secoes.find(s => s.chave === c) || null;
    const cadastro = pega('cadastro'), decisor = pega('decisor'), socios = pega('socios');

    // v15.1: o veredito de cada pergunta pode ser SIM, NÃO ou sem informação.
    // Antes eu só codei o NÃO — quando o LB confirmava, o script ignorava e
    // mandava "empresa não existe" com o enriquecimento dizendo o contrário.
    const veredito = (s, extraNeg) => {
      if (!s) return null;
      if (extraNeg && extraNeg.test(s.texto)) return false;
      const a = s.oracoes || { p: 0, n: 0 };
      if (a.p > a.n) return true;
      if (a.n > a.p) return false;
      if (a.p && a.n) return s.confAlta ? true : null;   // empate: confiança decide
      return null;
    };

    const cnpjAtivo = /cnpj (ativo|confirmad)|cnpj[^.]{0,40}confirmad/i.test(bruto)
                   && !/cnpj[^.]{0,30}n[ãa]o (confirmad|localizad|encontrad)/i.test(bruto);

    return {
      secoes,
      palavras: bruto.split(/\s+/).length,
      negativas: neg, positivas: pos, condicionais: cond,
      cnpjAtivo,
      empresaConfirmada: cnpjAtivo ? true : veredito(cadastro),
      decisorConfirmado: veredito(decisor, /sem confirma[çc][ãa]o de v[íi]nculo/i),
      socioEncontrado: veredito(socios),
      // ramo, quando o LB descreveu a atividade com firmeza
      ramo: (() => {
        const a = pega('atividade');
        if (!a || a.condicional || a.negativo) return null;
        const m = a.texto.match(/atua (?:como|em|no ramo de)\s+([^.;]{6,90})/i);
        return m ? m[1].trim() : null;
      })(),
      hipotetico: cond >= 2 && neg >= 3,
      confiavel: pos >= 3 && cond <= 1,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // HOMÔNIMO DE MARCA NACIONAL (v14.1)
  // Caso real: lead "CIELO" declarando R$ 401k-1M/mês. A IA achou A Cielo, a
  // adquirente de bilhões, e marcou empresa ✓ e margem ✓ em verde.
  // Marca nacional não compra assessoria de unidade franqueada — e o lead
  // quase sempre é uma PME homônima.
  //
  // Comparação por nome EXATO normalizado, nunca por trecho: "ATACADÃO DA
  // CONSTRUÇÃO" é um lead real e não pode casar com "Atacadão".
  // ═══════════════════════════════════════════════════════════════
  const MARCAS_NACIONAIS = new Set([
    // pagamentos e bancos
    'cielo', 'stone', 'pagseguro', 'pagbank', 'getnet', 'rede', 'sumup', 'infinitepay',
    'nubank', 'itau', 'bradesco', 'santander', 'banco do brasil', 'caixa', 'inter',
    'c6', 'c6 bank', 'original', 'safra', 'btg', 'xp', 'picpay', 'mercado pago',
    // varejo
    'magazine luiza', 'magalu', 'casas bahia', 'ponto frio', 'americanas', 'submarino',
    'renner', 'riachuelo', 'cea', 'marisa', 'havan', 'pernambucanas', 'centauro',
    'carrefour', 'atacadao', 'assai', 'pao de acucar', 'extra', 'dia', 'big',
    'mercado livre', 'shopee', 'shein', 'amazon', 'aliexpress',
    // alimentos e bebidas
    'ambev', 'brahma', 'skol', 'heineken', 'coca cola', 'pepsi', 'nestle', 'danone',
    'jbs', 'brf', 'sadia', 'perdigao', 'seara', 'friboi', 'ype', 'unilever',
    // saúde e beleza
    'natura', 'avon', 'boticario', 'o boticario', 'eudora', 'quem disse berenice',
    'drogasil', 'droga raia', 'raia drogasil', 'pague menos', 'panvel', 'dpsp',
    'hapvida', 'amil', 'unimed', 'sulamerica', 'porto seguro', 'bradesco saude',
    'fleury', 'dasa', 'einstein', 'sirio libanes',
    // serviços e tech
    'ifood', 'rappi', 'uber', '99', 'buser', 'localiza', 'movida', 'unidas',
    'vivo', 'claro', 'tim', 'oi', 'net', 'sky',
    'globo', 'record', 'sbt', 'band',
    'totvs', 'linx', 'senior', 'sankhya', 'omie', 'conta azul', 'vtex', 'nuvemshop',
    'gympass', 'wellhub', 'smart fit', 'bluefit', 'bodytech',
    // indústria e energia
    'petrobras', 'vale', 'gerdau', 'csn', 'usiminas', 'braskem', 'suzano', 'klabin',
    'weg', 'embraer', 'randon', 'marcopolo', 'tramontina',
    'ipiranga', 'shell', 'br', 'raizen', 'ultragaz', 'liquigas', 'copagaz',
    // educação
    'kroton', 'cogna', 'yduqs', 'estacio', 'anhanguera', 'unip', 'uninove', 'senai',
    'sesi', 'sebrae', 'senac', 'fgv', 'usp', 'unicamp',
    // logística
    'correios', 'jadlog', 'loggi', 'total express', 'braspress', 'jamef',
  ]);

  // Faturamento acima disto torna plausível ser a marca de verdade
  const TETO_PME_MENSAL = 4000000;

  function checarMarcaNacional(nomeEmpresa, fatMin) {
    if (!nomeEmpresa) return null;
    const n = normalizarTexto(nomeEmpresa)
      .replace(/\b(ltda|me|epp|eireli|s\/?a|sa)\b/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!MARCAS_NACIONAIS.has(n)) return null;         // match EXATO, nunca trecho
    if (fatMin && fatMin >= TETO_PME_MENSAL) return null;  // aí pode ser a de verdade

    return {
      marca: nomeEmpresa,
      texto: `"${nomeEmpresa}" é marca nacional — o lead declara porte de PME, `
           + 'então é quase certo que seja uma empresa homônima, não a marca',
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // RAZÃO SOCIAL POR INICIAIS (v13.2)
  // Em negócio pequeno é comum a razão social ser as iniciais do dono:
  // "J N V COMERCIO LTDA" = Jose Nelio Vanço. Caso real: o lead "JFC" tinha
  // Jose Nelio Vanço como contato, e o negócio dele era a Casa de Ferragens
  // Pai e Filho (J N V COMERCIO) em Cianorte — a IA foi parar numa consultoria
  // homônima em Maringá.
  // ═══════════════════════════════════════════════════════════════
  function iniciaisDoNome(nome) {
    return partesNome(nome)
      .filter(p => p.length > 1 && !PARTICULAS.has(p))
      .map(p => p[0])
      .join('')
      .toUpperCase();
  }

  function checarIniciais(nomeEmpresa, nomeContato) {
    if (!nomeEmpresa || !nomeContato) return null;
    // só a parte distintiva do nome — tira LTDA, ME, COMERCIO e afins
    const bruto = normalizarTexto(nomeEmpresa)
      .replace(/\b(ltda|me|epp|eireli|s\/?a|sa|comercio|com|industria|ind|servicos|serv|distribuidora|dist|e|de|da|do|dos|das)\b/g, ' ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .trim();
    const sigla = bruto.replace(/\s+/g, '').toUpperCase();
    if (!sigla || sigla.length < 2 || sigla.length > 4) return null;
    if (/\d/.test(sigla)) return null;

    const ini = iniciaisDoNome(nomeContato);
    if (!ini || ini.length < 2) return null;

    // bate exato, ou a sigla é subconjunto na mesma ordem
    const exato = sigla === ini;
    const contido = ini.includes(sigla) || sigla.split('').every((c, i) => ini[i] === c);
    if (!exato && !contido) return null;

    return {
      sigla,
      iniciais: ini,
      exato,
      texto: exato
        ? `"${nomeEmpresa}" são as iniciais de ${nomeContato}`
        : `"${nomeEmpresa}" bate com as iniciais de ${nomeContato}`,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // NATUREZA JURÍDICA (v16.0)
  // Em empresário individual a razão social É o nome da pessoa — então o
  // contato é o dono por definição, sem precisar de busca.
  // Caso FISIOMASSO: razão social "ELTON AUGUSTO CARDOSO", contato "Elton
  // Cardoso", e o box dizia "decisor não confirmado".
  // ═══════════════════════════════════════════════════════════════
  const NAT_INDIVIDUAL = /empres[áa]ri[oa] *\(individual\)|empres[áa]rio individual|\bEI\b|empresa individual de responsabilidade|eireli|MEI\b|microempreendedor individual/i;
  const NAT_SOCIEDADE  = /sociedade empres[áa]ria|limitada|LTDA|an[ôo]nima|\bS\/?A\b|simples/i;

  function lerNatureza(oficial, nomeContato) {
    if (!oficial) return null;
    const nat = String(oficial.natureza || '');
    const individual = NAT_INDIVIDUAL.test(nat);
    if (!individual) {
      return { texto: nat || null, individual: false, filial: oficial.matrizFilial === 'filial' };
    }

    // razão social bate com o nome do contato?
    const razao = normalizarTexto(oficial.razao_social || '');
    const cont = normalizarTexto(nomeContato || '');
    const pc = partesNome(nomeContato || '').filter(p => p.length > 2);
    const batem = pc.length >= 2 && pc.filter(p => razao.includes(p)).length >= 2;

    return {
      texto: nat, individual: true, filial: oficial.matrizFilial === 'filial',
      contatoEhDono: batem,
      razao: oficial.razao_social || null,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // CONTATO DO LEAD × CADASTRO PÚBLICO (v16.0)
  // Bater é corroboração quase de graça. Divergir é sinal de intermediário —
  // caso BANCO HR, onde a contato usava e-mail de agência.
  // O LeadBroker mascara (***@gmail.com, +55329*****), então a comparação é
  // por prefixo e sufixo, não exata.
  // ═══════════════════════════════════════════════════════════════
  function compararContatoCadastro(entry) {
    const ex = entry.extracted;
    const of = entry.oficial;
    if (!of) return null;

    const r = { tel: null, email: null, cidade: null, provas: 0, divergencias: 0 };

    // telefone — o LB mascara o meio, sobra DDD e às vezes o fim
    const telLead = String(ex.telefone || '').replace(/\D/g, '');
    if (telLead.length >= 4 && (of.telefones || []).length) {
      const dddLead = telLead.replace(/^55/, '').slice(0, 2);
      const bate = of.telefones.some(t => String(t).replace(/\D/g, '').startsWith(dddLead));
      r.tel = bate ? 'confere' : 'diverge';
      bate ? r.provas++ : r.divergencias++;
    }

    // e-mail — compara o domínio, que o LB não mascara
    const ei = ex.emailInfo;
    if (ei && ei.dominioFull && of.emailOficial) {
      const domOf = normalizarTexto(String(of.emailOficial).split('@')[1] || '');
      const domLead = normalizarTexto(ei.dominioFull);
      if (domOf) {
        const bate = domOf === domLead;
        r.email = bate ? 'confere' : 'diverge';
        bate ? r.provas++ : r.divergencias++;
      }
    }

    // cidade — o DDD do lead bate com o município do cadastro?
    // v17.10: cidade é campo pouco preenchido no formulário. Em branco ou
    // "Não informado" não é divergência — é ausência de dado.
    const cidBruta = ex.cidade || '';
    const cidVazia = !cidBruta || /^n[ãa]o informad|^-+$|^\s*$/i.test(String(cidBruta).trim());
    const cidLead = cidVazia
      ? normalizarTexto(ex.regiao ? ex.regiao.praca : '')   // cai pro DDD
      : normalizarTexto(cidBruta);
    const cidOf = normalizarTexto(of.municipio || '');
    if (cidLead && cidOf) {
      const bate = cidOf.includes(cidLead) || cidLead.includes(cidOf);
      if (bate) { r.cidade = 'confere'; r.provas++; }
      else if (cidVazia) {
        // v17.10: a cidade veio do DDD, que cobre dezenas de municípios.
        // Não bater aqui não é contradição — é imprecisão da fonte.
        r.cidade = null;
      } else { r.cidade = 'diverge'; r.divergencias++; }
    }

    return (r.provas || r.divergencias) ? r : null;
  }

  // ═══════════════════════════════════════════════════════════════
  // CONTAGEM DE FONTES (v16.0)
  // "existe · CNPJ ativo" e "existe · rastro online" apareciam com o mesmo peso.
  // A primeira tem prova oficial; a segunda tem um Instagram.
  // ═══════════════════════════════════════════════════════════════
  function contarFontes(entry) {
    const m = entry.m2 || entry.m1 || {};
    const f = { empresa: [], decisor: [], ramo: [] };

    if (entry.oficial && entry.oficial.cnpj) { f.empresa.push('Receita'); f.ramo.push('CNAE'); }
    // v17.4: a IA às vezes preenche o campo com a explicação de que NÃO achou —
    // "Não foi encontrado um perfil de Instagram específico...". Isso contava
    // como fonte. Só vale se parecer um endereço de verdade.
    const fonteReal = (v) => {
      const s = String(v || '').trim();
      if (!s || s.length > 90) return false;
      if (/n[ãa]o (foi )?(encontrad|localizad|identificad|h[áa])|sem (perfil|site|resultado)|n\/a|n[ãa]o informad/i.test(s)) return false;
      return /\.|@|instagram\.com|linkedin\.com|^[\w.-]+$/.test(s);
    };
    if (fonteReal(m.site)) f.empresa.push('site');
    if (fonteReal(m.instagram)) f.empresa.push('Instagram');
    if (fonteReal(m.linkedin_empresa)) f.empresa.push('LinkedIn');
    if (entry.enriq && entry.enriq.empresaConfirmada === true) f.empresa.push('LeadBroker');

    if (entry.qsaMatch) f.decisor.push('QSA');
    if (m.decisor_papel && !checarEvidenciaDecisor(m)) {
      f.decisor.push(m.decisor_fonte === 'linkedin_contato' ? 'LinkedIn' : 'investigação');
    }
    if (entry.natureza && entry.natureza.contatoEhDono) f.decisor.push('razão social');
    if (entry.enriq && entry.enriq.decisorConfirmado === true) f.decisor.push('LeadBroker');
    const cc = entry.contatoCadastro;
    if (cc && cc.provas >= 2) f.decisor.push('cadastro confere');

    if ((entry.m2 && entry.m2.ramo_real) || m.ramo_aparente) f.ramo.push('investigação');
    if (entry.enriq && entry.enriq.ramo) f.ramo.push('LeadBroker');

    return {
      ...f,
      rotulo: (arr) => arr.length ? `${arr.length} fonte${arr.length > 1 ? 's' : ''}: ${arr.join(', ')}` : 'sem fonte',
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // APROFUNDAMENTO AUTOMÁTICO (v16.11)
  // Quando o Momento 1 termina com box amarelo ou vermelho, o Momento 2 entra
  // numa fila e roda sozinho — enquanto o SDR lê os cards já prontos.
  //
  // Não roda quando: os 4 boxes estão verdes (não há dúvida a resolver),
  // é concorrente confirmado (já vetado, o M2 não muda), ou o M2 já rodou.
  // Fila serial, um de cada vez, pra não estourar limite de taxa da API.
  // ═══════════════════════════════════════════════════════════════
  let filaM2 = [];
  let rodandoM2 = false;

  function autoM2Ligado() { return GM_getValue('v4_auto_m2', '1') === '1'; }

  function precisaAprofundar(entry) {
    if (!autoM2Ligado()) return false;
    if (entry.m2 || entry.m2Rodando) return false;
    const f = entry.farol;
    if (!f || !f.boxes) return false;
    if (f.conc) return false;                       // concorrente: já vetado
    return Object.values(f.boxes).some(b => b.cor === 'amarelo' || b.cor === 'vermelho');
  }

  function enfileirarM2(entry) {
    if (!precisaAprofundar(entry)) return;
    if (filaM2.includes(entry)) return;
    filaM2.push(entry);
    tocarFilaM2();
  }

  // v23.2: a fila rodava um lead por vez. Com 5 leads e 13s cada, passava de
  // um minuto — e no leilão o lead já tinha ido embora.
  //
  // Agora roda 3 em paralelo. Não mais: as APIs limitam requisições por
  // minuto, e estourar isso derruba tudo (o 429 da BrasilAPI que apareceu
  // nos testes de hoje foi exatamente isso).
  const M2_PARALELO = 3;

  async function tocarFilaM2() {
    if (rodandoM2 || !filaM2.length) return;
    rodandoM2 = true;

    const trabalhar = async () => {
      while (filaM2.length) {
        const entry = filaM2.shift();
        if (!entry || entry.m2 || !entry.card || !entry.card.isConnected) continue;
        try {
          marcarAutoM2(entry, true);
          await doM2(entry);
        } catch (e) {
          console.warn('[V4] auto-M2 falhou:', e && e.message);
        } finally {
          marcarAutoM2(entry, false);
        }
        await new Promise(r => setTimeout(r, 250));   // respiro entre chamadas
      }
    };

    // três trabalhadores puxando da mesma fila
    const n = Math.min(M2_PARALELO, filaM2.length);
    await Promise.all(Array.from({ length: n }, trabalhar));
    rodandoM2 = false;
  }

  function marcarAutoM2(entry, ativo) {
    entry.m2Rodando = ativo;
    try {
      const b = entry.card && entry.card.querySelector('[data-act="m2"]');
      if (b) { b.textContent = ativo ? '⏳ aprofundando…' : '🔍 Momento 2 — aprofundar'; b.disabled = ativo; }
      renderRail();
    } catch (e) {}
  }

  // v17.1: o CNAE registrado e a razão social às vezes contam histórias
  // diferentes — a empresa faz as duas coisas e registrou uma só.
  // Caso TOTAL HOME: CNAE de montagem de móveis, razão social
  // "SERVIÇOS DE INSTALAÇÃO E MANUTENÇÃO ELÉTRICA".
  // Mostrar os dois lado a lado evita o card parecer errado.
  // v17.10: o nome do lead bate com a razão social OU com o nome fantasia?
  // Sem isso o script acusava divergência em empresa corretamente identificada.
  function nomeBateComEmpresa(nomeLead, oficial) {
    if (!nomeLead || !oficial) return null;
    const lead = normalizarTexto(nomeLead).replace(/[^a-z0-9 ]/g, ' ').trim();
    if (lead.length < 3) return null;
    const partes = lead.split(/\s+/).filter(p => p.length > 2 && parteDistintiva(p) && !PALAVRA_DE_RAMO.test(p));
    if (!partes.length) return null;

    const testa = (campo, rot) => {
      const v = normalizarTexto(campo || '').replace(/[^a-z0-9 ]/g, ' ');
      if (!v) return null;
      return partes.some(p => v.includes(p)) ? rot : null;
    };
    return testa(oficial.razao_social, 'razão social')
        || testa(oficial.nome_fantasia, 'nome fantasia')
        || null;
  }

  function compararCnaeRazao(oficial) {
    if (!oficial || !oficial.cnae || !oficial.razao_social) return null;

    const cnaeTxt = normalizarTexto(String(oficial.cnae).replace(/^\d+\s*/, ''));
    const razao = normalizarTexto(oficial.razao_social)
      .replace(/\b(ltda|me|epp|eireli|sa|s a|limitada|sociedade|empresaria)\b/g, ' ')
      .replace(/\s+/g, ' ').trim();

    // palavras de atividade na razão social (ignora nome próprio e fantasia)
    const ATIVIDADE = /(servi[çc]os? de |com[ée]rcio de |ind[úu]stria de |fabrica[çc][ãa]o de |instala[çc][ãa]o|manuten[çc][ãa]o|montagem|transporte|constru[çc][ãa]o|distribui|consultoria|assessoria|el[ée]tric|hidr[áa]ulic|refrigera[çc][ãa]o|usinagem|marcenaria|serralheria|automa[çc][ãa]o)/g;
    const naRazao = [...new Set(razao.match(ATIVIDADE) || [])].map(s => s.trim());
    if (!naRazao.length) return null;

    // v17.1: sinônimos — "indústria" e "fabricação" são a mesma atividade,
    // assim como "comércio" e "varejo/atacado". Sem isso o Alpatech (CNAE
    // "fabricação de artefatos", razão "indústria de plásticos") aparecia
    // como divergente sendo perfeitamente coerente.
    const SINONIMOS = [
      ['industria', 'fabricacao', 'fabrica'],
      ['comercio', 'varejo', 'atacad', 'revenda'],
      ['servicos de', 'servico'],
      ['montagem', 'instalacao'],
      ['construcao', 'obras', 'engenharia'],
    ];
    const cobre = (atividade) => {
      const a = atividade.replace(/ de$/, '').trim();
      if (!a || cnaeTxt.includes(a)) return true;
      const grupo = SINONIMOS.find(g => g.some(x => a.includes(x)));
      return !!(grupo && grupo.some(x => cnaeTxt.includes(x)));
    };

    const foraDoCnae = naRazao.filter(a => !cobre(a));
    if (!foraDoCnae.length) return null;

    return {
      cnae: String(oficial.cnae).replace(/^\d+\s*/, '').trim(),
      razao: oficial.razao_social,
      extras: foraDoCnae,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // PORTE MAIOR QUE O DECLARADO (v17.0)
  // O campo de faturamento é preenchido pelo dono em 30 segundos num anúncio,
  // e muita gente declara MENOS de propósito, achando que paga menos.
  //
  // A checagem de coerência só olhava o excesso (declarado acima do teto do
  // porte). Este módulo olha o outro lado — e é o lado que dá dinheiro: o
  // LeadBroker precifica pelo declarado, então lead subdeclarado está BARATO.
  //
  // Caso TOTAL HOME: EPP, capital R$ 200 mil, ativa desde 2011, declarando
  // R$ 51-70k/mês. Tudo aponta pra empresa maior, e o card dizia "confere".
  //
  // Regra: SINALIZA, não afirma. Precisa de 2+ indícios convergentes.
  // ═══════════════════════════════════════════════════════════════
  function checarPorteMaior(entry) {
    const ex = entry.extracted;
    const of = entry.oficial;
    const fat = ex.faturamentoMin;
    if (!of || !fat) return null;

    const sinais = [];

    // 1) porte na Receita bem acima do declarado
    const porte = normalizarPorte(of.porte);
    const teto = PORTE_TETO_ANUAL[porte];
    if (teto) {
      const tetoMes = teto / 12;
      // declarado abaixo de 1/4 do teto do porte que a empresa escolheu
      if (fat < tetoMes * 0.25 && teto >= 4800000) {
        sinais.push(`porte ${of.porte} na Receita (teto R$ ${fmtK(tetoMes)}/mês)`);
      }
    }

    // 2) capital social alto para o faturamento declarado
    const cap = Number(of.capital_social) || 0;
    if (cap >= 100000 && cap > fat * 2) {
      sinais.push(`capital social de R$ ${cap.toLocaleString('pt-BR')}`);
    }

    // 3) empresa madura declarando pouco
    const meses = idadeEmpresaMeses(of.abertura);
    if (meses && meses >= 120 && fat < 200000) {
      sinais.push(`${Math.floor(meses / 12)} anos de empresa`);
    }

    // 4) CNAE de indústria ou atacado — operação com escala
    const cnae = String(of.cnae || '');
    // v17.1: divisões 10-32 são fabricação. A 33 é MANUTENÇÃO E REPARAÇÃO —
    // serviço, não fábrica. Chamar isso de "CNAE de indústria" fazia o sinal
    // parecer falso positivo (caso TOTAL HOME, montagem de móveis).
    if (/^(1\d|2\d|3[0-2])\d{2}/.test(cnae.trim()) && fat < 400000) {
      sinais.push('CNAE de indústria');
    } else if (/atacad/i.test(cnae) && fat < 400000) {
      sinais.push('atua no atacado');
    }

    // 5) filiais
    if (of.matrizFilial === 'filial') sinais.push('é filial de um grupo');

    // 6) cargo do contato indica estrutura (gerente, diretor, coordenador)
    const m = entry.m2 || entry.m1 || {};
    const papel = String(m.decisor_papel || '');
    if (/gerente (geral|nacional|comercial|de vendas)|diretor|superintendente/i.test(papel) && fat < 400000) {
      sinais.push(`contato é ${papel.replace(/\s*\(.*?\)/, '')}`);
    }

    if (sinais.length < 2) return null;   // 1 indício sozinho é ruído

    // até onde o porte poderia ir, pela evidência mais forte
    const faixaAtual = faixaDeFaturamento(fat);
    return {
      sinais,
      declarado: ex.faturamento || null,
      faixaAtual: faixaAtual ? faixaAtual.rot : 'abaixo de 100k',
    };
  }

  // v18.6: "SERJA Indústria e Comércio de Marcenaria e Estofados" buscado entre
  // aspas não acha nada — a razão social real é "Serja Indústria de Móveis e
  // Marcenaria". Frase exata de seis palavras quase nunca casa.
  // O que identifica a empresa é o termo DISTINTIVO: "Serja".
  // O Google acha na primeira busca com ele; o nosso script não achava nunca.
  function nucleoDoNome(nome) {
    // v18.6: hífen e ponto fazem parte do nome — "H-NAY" e "RP" não podem ser
    // quebrados em pedaços. Só vira espaço o que separa palavras de verdade.
    const t = normalizarTexto(nome || '')
      .replace(/[^a-z0-9 .\-&]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    const GENERICO = /^(industria|comercio|servicos?|servico|solucoes|solucao|ltda|me|epp|eireli|sa|cia|grupo|empresa|e|de|da|do|das|dos|em|para|por|a|o|as|os|the|and|distribuidora|distribuicao|atacado|atacadista|varejo|varejista|representacoes|representacao|participacoes|holding|assessoria|consultoria|empreendimentos|negocios|marcenaria|estofados|moveis|confeccoes|transportes|logistica|construcoes|construtora|engenharia|tecnologia|sistemas|digital|group)$/;
    const partes = t.split(/\s+/).filter(p => p.length > 1 && !GENERICO.test(p));
    if (partes.length) return partes.slice(0, 2).join(' ');

    // Nome só de palavras genéricas ("JM Representações", "Comércio de Peças"):
    // o identificador é a sigla ou o primeiro token, mesmo sendo curto.
    const todos = t.split(/\s+/).filter(p => p.length > 1
      && !/^(ltda|me|epp|eireli|sa|cia|de|da|do|das|dos|e|em|para|por|a|o|as|os)$/.test(p));
    return todos.length ? todos.slice(0, 2).join(' ') : null;
  }

  // ═══════════════════════════════════════════════════════════════
  // CONCORRENTE PELO RAMO DA PRÓPRIA EMPRESA (v21.3)
  //
  // As regras de agência só eram consultadas no caminho das EMPRESAS DO
  // CONTATO. O ramo da empresa do lead nunca era testado.
  //
  // Caso ADSMENTORY: CNAE de "treinamento em desenvolvimento profissional"
  // (que não está na lista de CNAEs de agência) e ramo real "Treinamento e
  // Consultoria em Marketing Digital, foco em Facebook/Instagram Ads".
  // Passou como CAUTION — e é exatamente quem vende o que a V4 vende.
  //
  // O veto segue a definição da matriz: quem vende CRESCIMENTO DE RECEITA
  // B2B, não só marketing. Inclui consultoria comercial, inteligência de
  // vendas, SDR as a service, RevOps, e treinamento/mentoria de vendas.
  // ═══════════════════════════════════════════════════════════════
  const VENDE_CRESCIMENTO = new RegExp([
    // marketing e publicidade
    'ag[\u00ea e]ncia', 'publicidade', 'propaganda', 'marketing', 'm[\u00ed i]dia paga',
    'tr[\u00e1 a]fego pago', 'social media', 'assessoria de (imprensa|marketing)',
    'inbound', 'performance digital', 'growth',
    // comercial e vendas
    'consultoria (comercial|de vendas|em vendas)', 'assessoria (comercial|de vendas)',
    'intelig[\u00ea e]ncia (comercial|de vendas)', 'sales intelligence',
    'acelera[\u00e7 c][\u00e3 a]o (comercial|de vendas)', 'revops',
    'estrutura[\u00e7 c][\u00e3 a]o comercial', 'processos comerciais',
    // terceirização
    'prospec[\u00e7 c][\u00e3 a]o (terceirizada|ativa)', 'sdr as a service',
    'bdr as a service', 'gera[\u00e7 c][\u00e3 a]o de leads', 'terceiriza[\u00e7 c][\u00e3 a]o de vendas',
    // formação
    'treinamento (de|em) (vendas|marketing)', 'mentoria (de|em) (vendas|marketing|neg[\u00f3 o]cios)',
    'consultoria (de|em) marketing',
  ].join('|'), 'i');

  // o texto diz que a empresa VENDE isso, ou que ela COMPRA?
  const COMPRA_NAO_VENDE = /\b(busca|procura|quer|precisa|deseja|contratar|contrata[çc][ãa]o de|em busca de)\b/i;

  function ramoEhConcorrente(entry) {
    const m = entry.m2 || entry.m1 || {};
    const of = entry.oficial || {};
    const textos = [
      soAfirmativo(m.ramo_real || ''),
      soAfirmativo(m.ramo_aparente || ''),
      of.cnae || '',
      of.razao_social || '',
      of.nome_fantasia || '',
      entry.extracted ? entry.extracted.nomeEmpresa || '' : '',
    ].filter(Boolean);

    for (const t of textos) {
      if (!VENDE_CRESCIMENTO.test(t)) continue;
      // "busca uma agência de marketing" é cliente, não concorrente
      if (COMPRA_NAO_VENDE.test(t)) continue;
      const trecho = (t.match(VENDE_CRESCIMENTO) || [''])[0];
      return { trecho, onde: t.slice(0, 90) };
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // MODO TIME (v23.0)
  //
  // Com o envio automático pro GHL, o SDR não precisa marcar nada — e vários
  // botões do painel só servem pra quebrar coisa: limpar cache, limpar fila,
  // limpar histórico, remover chaves. Nenhum resolve problema de verdade;
  // o caminho pra isso é o Diagnóstico.
  //
  // Quem configurou as chaves nesta máquina (souDono) continua vendo tudo.
  // Quem entrou pelo código do time vê só o que usa.
  // ═══════════════════════════════════════════════════════════════
  function modoTime() {
    try { return !souDono(); } catch (e) { return true; }
  }

  function aplicarModoTime() {
    if (!modoTime()) return;
    const esconder = [
      'v4-clear-cache',    // apaga cache
      'v4-clear-queue',    // apaga a fila
      'v4-hist-clear',     // apaga o histórico
      'v4-key',            // remove as chaves
      'v4-race',           // ajuste fino
      'v4-model',          // ajuste fino
      'v4-consumo',        // gestão de custo, não operação
      'v4-export-json',    // exportação técnica
    ];
    for (const id of esconder) {
      const e = document.getElementById(id);
      if (e) e.style.display = 'none';
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // AQUISIÇÕES → GHL (v22.0)
  //
  // Ninguém marca "Arrematei" na hora do leilão — a pressa é outra. Então o
  // script lê a própria página de Minhas Aquisições do LeadBroker, cruza com
  // as análises que já estão no histórico local e manda o lead completo pro
  // GHL. Da compra ao CRM em segundos, sem clique.
  //
  // Vai pela API (não por webhook de workflow) porque workflow cobra por
  // execução. Criar contato e anexar nota não consome tarefa.
  // ═══════════════════════════════════════════════════════════════
  const GHL_API = 'https://services.leadconnectorhq.com';
  const GHL_VERSION = '2021-07-28';

  function ghlCfg() {
    return {
      token: GM_getValue('v4_ghl_token', ''),
      location: GM_getValue('v4_ghl_location', ''),
    };
  }

  function ghlChamar(caminho, metodo, corpo) {
    const { token } = ghlCfg();
    if (!token) return Promise.resolve({ erro: 'sem token do GHL' });
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: metodo,
        url: GHL_API + caminho,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Version': GHL_VERSION,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        data: corpo ? JSON.stringify(corpo) : undefined,
        timeout: 15000,
        onload(r) {
          try {
            const d = r.responseText ? JSON.parse(r.responseText) : {};
            if (r.status >= 400) return resolve({ erro: d.message || `HTTP ${r.status}`, status: r.status, d });
            resolve(d);
          } catch (e) { resolve({ erro: e.message }); }
        },
        onerror() { resolve({ erro: 'rede' }); },
        ontimeout() { resolve({ erro: 'timeout' }); },
      });
    });
  }

  // ─── a nota que o SDR vai ler ───────────────────────────────────
  function notaDaAnalise(an, compra) {
    if (!an) {
      return `LEAD COMPRADO NO LEADBROKER\n\n`
        + `Empresa: ${compra.empresa}\nResponsável: ${compra.contato}\n`
        + `Valor pago: ${compra.valor}\nArrematador: ${compra.arrematador}\n\n`
        + `⚠️ Este lead não passou pelo V4 Lead Analyzer — sem análise prévia.`;
    }
    const L = [];
    L.push(`═══ ${an.empresa || compra.empresa} ═══`);
    L.push(`FAROL: ${an.farol || '?'}`);
    L.push('');
    if (an.boxes) {
      const ic = c => c === 'verde' ? '✅' : c === 'vermelho' ? '❌' : c === 'concorrente' ? '🚨' : '⚠️';
      L.push('OS 4 BOXES');
      L.push(`${ic(an.boxes.concorrente)} Concorrente`);
      L.push(`${ic(an.boxes.empresa)} Empresa`);
      L.push(`${ic(an.boxes.decisor)} Decisor`);
      L.push(`${ic(an.boxes.margem)} Margem${an.margemBucket ? ` · ${an.margemBucket}` : ''}`);
      L.push('');
    }
    L.push('DADOS DO LEAD');
    if (an.cnpj) L.push(`CNPJ: ${an.cnpj}`);
    if (an.cnae) L.push(`CNAE: ${an.cnae}`);
    if (an.ramoReal) L.push(`Ramo real: ${an.ramoReal}`);
    if (an.decisor) L.push(`Decisor: ${an.decisor}`);
    if (an.faturamento) L.push(`Faturamento declarado: ${an.faturamento}`);
    if (an.tier) L.push(`Tier: ${an.tier}`);
    L.push('');
    L.push('COMPRA');
    L.push(`Valor pago: ${compra.valor}`);
    L.push(`Arrematador: ${compra.arrematador}`);
    L.push(`Analisado por: ${an.usuario || '?'}`);
    if (an.m3) { L.push(''); L.push('DOSSIÊ SDR'); L.push(an.m3); }
    return L.join('\n');
  }

  // ─── manda um lead comprado pro GHL ─────────────────────────────
  async function enviarCompraParaGHL(compra, an) {
    const { token, location } = ghlCfg();
    if (!token || !location) return { erro: 'GHL não configurado' };

    const tel = String(compra.telefone || '').replace(/\D/g, '');
    const nome = String(compra.contato || '').trim();
    const partes = nome.split(/\s+/);

    const contato = {
      locationId: location,
      firstName: partes[0] || nome || 'Lead',
      lastName: partes.slice(1).join(' ') || '',
      name: nome || compra.empresa,
      companyName: compra.empresa || '',
      phone: tel ? (tel.startsWith('55') ? '+' + tel : '+55' + tel) : undefined,
      email: compra.email || an && an.email || undefined,
      source: 'LeadBroker',
      tags: ['leadbroker', (an && an.farol ? an.farol.toLowerCase() : 'sem-analise')],
    };
    Object.keys(contato).forEach(k => contato[k] === undefined && delete contato[k]);

    const r = await ghlChamar('/contacts/', 'POST', contato);
    // contato já existe: o GHL devolve o id no corpo do erro
    const id = (r.contact && r.contact.id) || (r.d && r.d.meta && r.d.meta.contactId);
    if (!id) return { erro: r.erro || 'sem id de contato', bruto: r };

    const nota = await ghlChamar(`/contacts/${id}/notes`, 'POST', {
      body: notaDaAnalise(an, compra),
      userId: undefined,
    });

    return { id, nota: !nota.erro, erroNota: nota.erro };
  }

  // ─── lê a página Minhas Aquisições ──────────────────────────────
  function lerAquisicoes() {
    const linhas = [];
    // a tabela tem cabeçalho Tipo | Empresa | Responsável | Cargo | Telefone | Valor | Arrematador
    document.querySelectorAll('tr, [role="row"]').forEach(tr => {
      const cels = [...tr.querySelectorAll('td, [role="cell"]')].map(td => (td.textContent || '').trim());
      if (cels.length < 6) return;
      const tel = cels.find(c => /^\+?55?\s?\d{2}\s?9?\d{4}[-\s]?\d{4}$/.test(c.replace(/\s+/g, ' ')));
      const valor = cels.find(c => /^R\$\s?[\d.,]+$/.test(c));
      if (!tel || !valor) return;
      const iTel = cels.indexOf(tel);
      linhas.push({
        empresa: cels[iTel - 3] || '',
        contato: cels[iTel - 2] || '',
        cargo: cels[iTel - 1] || '',
        telefone: tel,
        valor,
        arrematador: cels[iTel + 2] || cels[cels.length - 1] || '',
      });
    });
    return linhas.filter(l => l.empresa);
  }

  // v23.1: o dossiê precisa do entry completo (extracted, m1, m2, oficial,
  // boxes), não só do resumo que vai pro histórico. Reconstrói a partir do
  // texto bruto guardado, que é o que o cache preserva.
  function entryDoHistorico(meta) {
    if (!meta) return null;
    try {
      const bruto = meta.rawText || meta.raw || '';
      if (!bruto) return null;
      const cached = getCached(bruto);
      if (!cached || !cached.m1) return null;
      return {
        id: 'ghl-' + Date.now(),
        rawText: bruto,
        extracted: preExtract(bruto),
        m1: cached.m1,
        m2: cached.m2 || null,
        oficial: cached.oficial || null,
        card: null,
      };
    } catch (e) { return null; }
  }

  // ─── cruza a compra com a análise guardada ──────────────────────
  // O histórico tem o farol, os boxes e o dossiê. A ponte é o telefone
  // (sem máscara nas aquisições) ou o nome da empresa.
  function acharAnalise(compra) {
    let itens = [];
    try { itens = listHistory(); } catch (e) { return null; }
    const tel = String(compra.telefone || '').replace(/\D/g, '').slice(-9);
    const emp = normalizarTexto(compra.empresa || '');
    const nuc = normalizarTexto(nucleoDoNome(compra.empresa) || '');

    for (const it of itens) {
      const m = it.meta || it;
      const t = String(m.telefone || '').replace(/\D/g, '').slice(-9);
      if (tel && t && tel === t) return m;
    }
    // sem telefone no histórico, casa pelo nome
    for (const it of itens) {
      const m = it.meta || it;
      const e = normalizarTexto(m.empresa || '');
      if (!e) continue;
      if (e === emp) return m;
      if (nuc && nuc.length > 3 && e.includes(nuc)) return m;
    }
    return null;
  }

  // ─── vigia a página de aquisições ───────────────────────────────
  const ENVIADOS_KEY = 'v4_ghl_enviados';
  function jaEnviado(chave) {
    try { return (GM_getValue(ENVIADOS_KEY, '') || '').split('|').includes(chave); }
    catch (e) { return false; }
  }
  function marcarEnviado(chave) {
    try {
      const l = (GM_getValue(ENVIADOS_KEY, '') || '').split('|').filter(Boolean);
      l.push(chave);
      GM_setValue(ENVIADOS_KEY, l.slice(-400).join('|'));
    } catch (e) {}
  }

  let vigiaAtivo = false;
  async function vigiarAquisicoes() {
    const { token, location } = ghlCfg();
    if (!token || !location) return;
    if (!/aquisi|acquisition|compras/i.test(location.href || window.location.href + document.title)) {
      // só roda quando a página de aquisições está aberta
      if (!/Minhas Aquisi/i.test(document.body.textContent || '')) return;
    }
    if (vigiaAtivo) return;
    vigiaAtivo = true;

    try {
      const linhas = lerAquisicoes();
      for (const c of linhas) {
        const chave = (c.telefone || c.empresa).replace(/\D/g, '') || c.empresa;
        if (jaEnviado(chave)) continue;

        let an = acharAnalise(c);

        // v23.1: o dossiê só é gerado para lead COMPRADO. Antes ele ficava num
        // botão que ninguém clicava no leilão — e depois da compra o lead já
        // tinha saído da tela. Aqui a compra já aconteceu: o investimento está
        // feito, e alguns centavos de dossiê ao lado de centenas de reais de
        // lead é decisão fácil.
        //
        // Bônus: sai depois do Momento 2, então com mais informação do que
        // teria no momento do leilão.
        if (an && !an.m3) {
          try {
            mostrarDica(`<b>Gerando dossiê</b><br>${esc(c.empresa)}`, 30000);
            const entry = entryDoHistorico(an);
            if (entry) {
              const m3 = await runMomento3(entry);   // devolve o texto do dossiê
              if (m3 && typeof m3 === 'string' && m3.length > 40) {
                an = { ...an, m3 };
                try { saveEntry({ ...entry, m3 }); } catch (e) {}
              }
            }
          } catch (e) { console.warn('[V4] dossiê automático:', e); }
        }

        const r = await enviarCompraParaGHL(c, an);
        if (r.erro) {
          console.warn('[V4] GHL falhou:', c.empresa, '·', r.erro);
          continue;
        }
        marcarEnviado(chave);
        console.log('[V4] → GHL:', c.empresa, an ? `(com análise · ${an.farol})` : '(sem análise)');
        mostrarDica(`<b>→ GHL</b><br>${esc(c.empresa)}${an ? ` · ${esc(an.farol || '')}` : ' · sem análise prévia'}`, 5000);
        await new Promise(r => setTimeout(r, 600));
      }
    } catch (e) {
      console.warn('[V4] vigia de aquisições:', e);
    } finally {
      vigiaAtivo = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // BUSCA CRUA — ACHAR O CNPJ ANTES DA IA (v21.0)
  //
  // O Gemini fazia três coisas numa chamada: raciocinar, buscar e escrever o
  // JSON. Por isso levava 10 a 20 segundos — e em cinco casos reais (SERJA,
  // JRMAR, Massas Alberganti, NO ALVO, EVOLUTION) não achava o que o Google
  // acha de primeira.
  //
  // Aqui a busca é crua: devolve títulos e trechos em JSON, em menos de um
  // segundo. O CNPJ completo costuma estar no próprio texto do resultado —
  // os agregadores publicam no título e na URL. Um regex extrai, e a BrasilAPI
  // faz o resto.
  //
  // A IA entra depois, só pro que exige julgamento.
  // ═══════════════════════════════════════════════════════════════
  const SERPER_URL = 'https://google.serper.dev/search';

  function buscarWeb(query, timeout = 4000) {
    const key = GM_getValue('v4_serper_key', '');
    if (!key || !query) return Promise.resolve(null);
    return new Promise(resolve => {
      const t0 = Date.now();
      GM_xmlhttpRequest({
        method: 'POST', url: SERPER_URL,
        headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
        data: JSON.stringify({ q: query, gl: 'br', hl: 'pt-br', num: 10 }),
        timeout,
        onload(r) {
          try {
            if (r.status >= 400) return resolve({ erro: `HTTP ${r.status}`, ms: Date.now() - t0 });
            const d = JSON.parse(r.responseText);
            const itens = [...(d.organic || []), ...(d.knowledgeGraph ? [d.knowledgeGraph] : [])];
            resolve({
              ms: Date.now() - t0,
              query,
              itens: itens.map(x => ({
                titulo: x.title || x.name || '',
                trecho: x.snippet || x.description || '',
                url: x.link || x.website || '',
              })),
            });
          } catch (e) { resolve({ erro: e.message, ms: Date.now() - t0 }); }
        },
        onerror() { resolve({ erro: 'rede' }); },
        ontimeout() { resolve({ erro: 'timeout' }); },
      });
    });
  }

  // Varre os resultados atrás de um CNPJ que comece com o prefixo do cadastro.
  // Sem prefixo, aceita o primeiro CNPJ que apareça junto do nome da empresa.
  function garimparCnpj(resultados, prefixoDeclarado, nomeEmpresa) {
    if (!resultados || !resultados.itens) return null;
    const pref = String(prefixoDeclarado || '').replace(/\D/g, '');
    const alvo = pref.slice(0, Math.min(pref.length, 8));
    const nucleo = normalizarTexto(nucleoDoNome(nomeEmpresa) || '');

    const achados = [];
    for (const it of resultados.itens) {
      const texto = `${it.titulo} ${it.trecho} ${it.url}`;
      // CNPJ formatado ou corrido
      const re = /(\d{2})[.\s-]?(\d{3})[.\s-]?(\d{3})[/\s-]?(\d{4})[-\s]?(\d{2})/g;
      let m;
      while ((m = re.exec(texto)) !== null) {
        const c = (m[1] + m[2] + m[3] + m[4] + m[5]).replace(/\D/g, '');
        if (c.length !== 14) continue;
        const casaPrefixo = alvo ? c.startsWith(alvo) : false;
        const citaNome = nucleo && normalizarTexto(texto).includes(nucleo);
        achados.push({ cnpj: c, casaPrefixo, citaNome, fonte: it.url, titulo: it.titulo,
                       // v23.5: citar um nome genérico não prova nada
                       nomeGenerico: /^(instituto|associa|funda|centro|col[ée]gio|escola|cl[íi]nica|academia|igreja|sociedade|cooperativa|grupo|casa)/i.test(nucleo) });
      }
    }
    if (!achados.length) return null;

    // prioridade: bate o prefixo > cita o nome > primeiro que apareceu
    achados.sort((a, b) => (b.casaPrefixo - a.casaPrefixo) || (b.citaNome - a.citaNome));
    const top = achados[0];
    // com prefixo declarado, só vale se bater — senão é outra empresa
    if (alvo && !top.casaPrefixo) return null;
    return top;
  }

  // Monta as consultas e devolve o CNPJ, se achar.
  async function acharCnpjPorBusca(ex) {
    if (!GM_getValue('v4_serper_key', '')) return null;

    const nucleo = nucleoDoNome(ex.nomeEmpresa) || ex.nomeEmpresa || '';
    const px = String(ex.cnpjParcial || '').replace(/\D/g, '');

    // v23.5: SÓ a cidade declarada no cadastro. A praça deduzida do DDD é
    // palpite, e palpite errado estraga a busca — caso INSTITUTO
    // PRESBITERIANO: DDD 87 sugeriu "Petrolina / Caruaru", a empresa é de
    // Lajedo, e a busca trouxe o CNPJ de outro instituto presbiteriano.
    // A barra ainda ia pra consulta como se fosse parte do nome.
    const cidade = (ex.cidade && !/não informado|nao informado/i.test(ex.cidade))
      ? String(ex.cidade).split('/')[0].trim() : '';

    // v23.5: nome genérico não identifica empresa. "instituto presbiteriano"
    // existe às dezenas; buscar por ele traz qualquer um.
    const GENERICO_DEMAIS = /^(instituto|associa[çc][ãa]o|funda[çc][ãa]o|centro|col[ée]gio|escola|cl[íi]nica|academia|igreja|paroquia|sociedade|cooperativa|sindicato|grupo|casa|espa[çc]o|studio|est[úu]dio)(\s|$)/i;
    const nucleoServe = nucleo && nucleo.length > 3 && !GENERICO_DEMAIS.test(nucleo);

    const queries = [];
    // com prefixo do CNPJ é sempre seguro — ele é a prova de identidade
    if (px.length >= 4 && nucleo) queries.push(`"${nucleo}" ${px} CNPJ`);
    // sem prefixo, só busca por nome se o nome identificar de verdade
    if (nucleoServe) queries.push(`${nucleo} ${cidade} CNPJ razão social`.replace(/\s+/g, ' ').trim());
    if (px.length >= 4) queries.push(`${px} CNPJ ${cidade}`.replace(/\s+/g, ' ').trim());
    if (!queries.length) return null;

    for (const q of queries) {
      const r = await buscarWeb(q);
      if (!r || r.erro) continue;
      const achado = garimparCnpj(r, px, ex.nomeEmpresa);
      if (achado) return { ...achado, query: q, ms: r.ms };
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // CONFRONTO DO CNPJ DECLARADO (v18.0)
  // O LeadBroker mascara o documento mas deixa os primeiros dígitos visíveis.
  // Esses dígitos são a prova mais forte de identidade que o lead traz — e o
  // script estava adotando qualquer CNPJ que a investigação trouxesse.
  //
  // Caso NEXEL: cadastro dizia 43.324*****, a busca devolveu 09.014.898/0001-21
  // (distribuidora de informática) e o card assumiu a empresa errada inteira —
  // CNAE, razão social, sócios, data de abertura, tudo de outra empresa.
  //
  // Caso JM Representações: mesmo padrão, com 22.183 no cadastro e 59.781.121
  // adotado. Produziu "ativa desde 2025" numa empresa de 2015 e uma flag de
  // irregularidade fiscal que pertencia a terceiro.
  //
  // Regra: prefixo declarado que não bate = empresa errada. Os dados oficiais
  // são descartados; o lead segue pelo nome, com confiança menor.
  // ═══════════════════════════════════════════════════════════════
  function confrontarCnpj(cnpjAchado, cnpjParcialDeclarado) {
    const achado = String(cnpjAchado || '').replace(/\D/g, '');
    const decl = String(cnpjParcialDeclarado || '').replace(/\D/g, '');
    if (!achado || achado.length !== 14) return null;
    if (!decl || decl.length < 4) return null;          // sem parcial: nada a confrontar

    const prefixo = decl.slice(0, Math.min(decl.length, 8));
    if (achado.startsWith(prefixo)) {
      return { bate: true, prefixo, digitos: prefixo.length };
    }
    return {
      bate: false, prefixo, digitos: prefixo.length,
      texto: `o cadastro do lead começa com ${fmtPrefixo(prefixo)} e o CNPJ achado é `
           + `${fmtCnpj(achado)} — são empresas diferentes`,
    };
  }

  function fmtPrefixo(d) {
    const s = String(d);
    if (s.length <= 2) return s;
    if (s.length <= 5) return `${s.slice(0, 2)}.${s.slice(2)}`;
    return `${s.slice(0, 2)}.${s.slice(2, 5)}.${s.slice(5)}`;
  }

  // ═══════════════════════════════════════════════════════════════
  // GUARDA CONTRA NEGAÇÃO (v17.6)
  // O erro que mais deu bug nesta ferramenta: a IA escreve "não há evidências
  // de X" e o script casa com o "X". Aconteceu no enriquecimento do LeadBroker,
  // no vínculo de agência, na evidência do decisor e na régua de margem.
  //
  // Em vez de corrigir ponto a ponto, um guarda só: antes de classificar ou
  // confirmar qualquer coisa a partir de texto da IA, remove os trechos que
  // estão dentro de uma negação.
  // ═══════════════════════════════════════════════════════════════
  // ⚠️ Nem toda negação nega a afirmação. Em CNAE isso é comum e legítimo:
  // "Clínica de estética NÃO cirúrgica", "Restaurante SEM entretenimento",
  // "produtos alimentícios NÃO especificados anteriormente". Ali a negação
  // qualifica um detalhe do produto ou serviço.
  //
  // O que precisa ser barrado é a negação de EXISTÊNCIA ou de CONFIRMAÇÃO:
  // "não há evidências", "nenhum sócio localizado", "sem vínculo comprovado".
  //
  // Regra: a oração nega quando tem um MARCADOR de negação E um termo de
  // existência/prova. Duas listas curtas em vez de um regex gigante.
  const NEG_MARCADOR = /\b(n[ãa]o|nenhum[ao]?|sem|aus[êe]ncia|inexist\w*|nada)\b/i;
  const NEG_ALVO = /\b(evid[êe]ncias?|provas?|confirma\w*|comprova\w*|v[íi]nculos?|registros?|rastros?|encontr\w*|localiz\w*|identific\w*|verific\w*|associ\w*|vincul\w*|h[áa]|existe\w*|consta\w*|aparece\w*|possui|resultados?|perfil|presen[çc]a|informa[çc][õo]es|dados|fontes?|refer[êe]ncias?)\b/i;

  // "não é agência", "não são sócios", "não atua como" — negação de ATRIBUTO.
  // Não é sobre existência, mas também não pode ser lida como afirmação.
  const NEG_ATRIBUTO = /n[ãa]o\s+(é|s[ãa]o|est[áa]|estava|era|atua|trabalha|presta|faz|possui|tem|se trata|parece)(\s|,|\.|$)/i;

  // uma oração nega existência ou atributo?
  // "ausência de X" e "inexistência de X" negam sem precisar de segundo termo
  const NEG_SOZINHA = /\b(aus[êe]ncia|inexist[êe]ncia|falta|car[êe]ncia)\s+de\b|\binexistent/i;

  function oracaoNega(o) {
    return (NEG_MARCADOR.test(o) && NEG_ALVO.test(o))
        || NEG_ATRIBUTO.test(o)
        || NEG_SOZINHA.test(o);
  }

  // devolve só as orações que NÃO negam existência
  function soAfirmativo(texto) {
    if (!texto) return '';
    const t = String(texto);
    if (!oracaoNega(t)) return t;                    // nada a limpar
    const orac = t.split(/[;.]|(?:,\s*(?=(?:mas|por[ée]m|embora|contudo|todavia|apesar|no entanto)\b))/i);
    return orac.filter(o => o.trim() && !oracaoNega(o)).join('. ').trim();
  }

  // a frase inteira nega a existência do que descreve?
  function ehNegacao(texto) {
    if (!texto) return false;
    return oracaoNega(String(texto)) && soAfirmativo(texto).length < 8;
  }

  // ═══════════════════════════════════════════════════════════════
  // OS 4 BOXES E O FAROL (v11.0)
  // Substituem os 3 checks + tags + valor endereçável. Cada box devolve um
  // veredito; o farol é a soma. Só concorrente confirmado veta sozinho.
  // ═══════════════════════════════════════════════════════════════
  const CARGO_SOCIO   = /\bs[óo]cio|\bdono\b|propriet[áa]ri|fundador|\btitular\b|administrador|\bceo\b/i;
  const CARGO_DIRETOR = /\bdiretor|\bpresidente\b|\bvp\b|vice.?presidente/i;
  const CARGO_CLEVEL  = /\b(c[eftoim]o|cxo)\b|\bchief\b|\bsuperintendente/i;
  const CARGO_GERENTE = /\bgerente\b|\bhead\b|\bgestor/i;
  // Coordenador e supervisor NÃO têm alçada em nenhum porte — coordenam, não aprovam.

  const ALCADA = [
    { max: 200000,   res: [CARGO_SOCIO], rot: 'sócio, dono ou fundador' },
    { max: 400000,   res: [CARGO_SOCIO, CARGO_DIRETOR], rot: 'sócio, dono ou diretor' },
    { max: 1000000,  res: [CARGO_SOCIO, CARGO_DIRETOR, CARGO_CLEVEL], rot: 'sócio, diretor ou C-level' },
    { max: 4000000,  res: [CARGO_SOCIO, CARGO_DIRETOR, CARGO_CLEVEL, CARGO_GERENTE], rot: 'sócio, diretor, head ou gerente' },
    { max: Infinity, res: [CARGO_SOCIO, CARGO_DIRETOR, CARGO_CLEVEL, CARGO_GERENTE], rot: 'diretor, head ou gerente' },
  ];

  function alcadaDoPorte(fat) { return ALCADA.find(a => (fat || 0) < a.max) || ALCADA[ALCADA.length - 1]; }
  function temAlcada(cargo, fat) {
    if (!cargo) return null;
    const t = normalizarTexto(cargo);
    return alcadaDoPorte(fat).res.some(re => re.test(t));
  }

  // CNAE de concorrente: só os 3 códigos definidos pela unidade
  const CNAE_CONC = ['7311400', '7319003', '7319004'];
  // v16.7: só o CNAE PRINCIPAL veta. É comum abrir empresa registrando meia
  // dúzia de códigos secundários por precaução, pra não precisar alterar depois.
  // Caso real: Lse Soluções tinha marketing direto entre os secundários, e a
  // empresa é consultoria de energia. Vetar por isso descarta lead legítimo.
  function cnaeConcorrente(entry) {
    const c = entry.oficial && entry.oficial.cnae;   // este campo é o principal
    if (!c) return null;
    const cod = String(c).replace(/\D/g, '').slice(0, 7);
    if (CNAE_CONC.includes(cod)) return String(c).replace(/^\d+\s*/, '');
    if (/ag[êe]ncias? de publicidade|marketing direto|consultoria em publicidade/i.test(normalizarTexto(c))) {
      return String(c).replace(/^\d+\s*/, '');
    }
    return null;
  }

  // v15.2: RESTAURADA — esta função existia na v10.3 e sumiu quando a v11 foi
  // reconstruída sobre a v9.37. Sem ela, o lead "DA VILA" voltava a ser vetado
  // como agência só porque a busca "DA VILA agência" achou uma "Agência da Vila".
  // 🚨 é o veto mais caro: exige prova de que a empresa achada é a do lead.
  const PALAVRAS_ACHADO = /ag[êe]ncia|marketing|digital|publicidade|propaganda|comunica[çc][ãa]o|m[íi]dia|performance|growth|assessoria/i;

  function nomeGenerico(nome) {
    const p = partesNome(nome).filter(w => w.length > 2);
    if (!p.length) return true;
    return !p.some(w => parteDistintiva(w) && w.length >= 5);
  }

  function corroboracaoConcorrente(entry, m) {
    const ex = entry.extracted;
    const leadNome = ex.nomeEmpresa || '';
    const achado = String(m.empresa_evidencia || '') + ' ' + String(m.concorrente_evidencia || '')
                 + ' ' + String(m.ramo_aparente || m.ramo_real || '');
    const provas = [];

    if (entry.oficial && entry.oficial.cnpj) provas.push('CNPJ');
    if (m.decisor_papel && !checarEvidenciaDecisor(m)) provas.push('contato vinculado');

    const nAch = normalizarTexto(achado);
    const cid = ex.cidade, uf = ex.estado;
    if (cid && nAch.includes(normalizarTexto(cid))) provas.push('cidade confere');
    else if (uf && new RegExp(`\\b${normalizarTexto(uf)}\\b`).test(nAch)) provas.push('UF confere');

    if (leadNome && !nomeGenerico(leadNome)) provas.push('nome distintivo');

    // a busca por "agência" pode ter introduzido a conclusão
    const circular = PALAVRAS_ACHADO.test(achado) && nomeGenerico(leadNome) && !provas.length;
    return { provas, ok: provas.length > 0, circular };
  }

  function boxConcorrente(entry) {
    // v21.3: o ramo da própria empresa vale veto — vinha sendo ignorado
    const rc = ramoEhConcorrente(entry);
    if (rc) {
      return {
        cor: 'concorrente', titulo: 'Concorrente',
        txt: 'É concorrente — não dê lance',
        sub: `vende "${rc.trecho}" · ${rc.onde}`,
        veta: true,
      };
    }
    const m = entry.m2 || entry.m1 || {};

    // v11.1: sem identificar a empresa não dá pra afirmar o ramo dela — nem que
    // É agência, nem que NÃO é. Caso real: "PLAYERONE" com empresa não achada e
    // o box dizendo "não é agência". A conclusão valia pra alguma empresa
    // encontrada na busca, não necessariamente pra esta.
    const identificada = m.empresa_existe === 'sim' || !!(entry.oficial && entry.oficial.cnpj);

    const porCnae = cnaeConcorrente(entry);
    if (porCnae) return { cor: 'concorrente', titulo: 'Concorrente', txt: 'É agência — não dê lance', sub: `CNAE: ${porCnae}`, veta: true };
    // CNAE existe e não é de agência → desmente a IA
    if (entry.oficial && entry.oficial.cnae && m.is_concorrente === true) {
      return { cor: 'amarelo', titulo: 'Concorrente', txt: 'IA diz agência, CNAE diz outra coisa', sub: String(entry.oficial.cnae).slice(0, 46), pendente: 'concorrente' };
    }
    if (m.is_concorrente === true) {
      if (!identificada) {
        return { cor: 'amarelo', titulo: 'Concorrente', txt: 'possível agência — não confirmado',
          sub: 'empresa não identificada: a agência achada pode ser outra', pendente: 'concorrente' };
      }
      // v15.2: exige prova de que a agência achada é a empresa do lead
      const cor = corroboracaoConcorrente(entry, m);
      if (!cor.ok) {
        entry.concFraco = cor;
        return {
          cor: 'amarelo', titulo: 'Concorrente',
          txt: 'possível agência — não confirmado',
          sub: cor.circular
            ? 'nome genérico: a busca por "agência" pode ter achado outra empresa'
            : 'nada liga a agência achada a este lead',
          pendente: 'concorrente',
        };
      }
      return {
        cor: 'concorrente', titulo: 'Concorrente', txt: 'É agência — não dê lance',
        sub: `confirmado por ${cor.provas.join(' · ')}`, veta: true,
      };
    }
    if (m.concorrente_suspeita) return { cor: 'amarelo', titulo: 'Concorrente', txt: 'possível — verificar', pendente: 'concorrente' };
    // v14.2: mesmo que a EMPRESA do lead não seja agência, o CONTATO pode vir
    // de uma. Sinais: negócios dele são agências, ou o domínio do e-mail é.
    const vinc = checarVinculoAgencia(entry);
    entry.vinculoAgencia = vinc;
    if (vinc && m.is_concorrente !== true) {
      const p = vinc.provas[0];
      const mais = vinc.provas.length > 1 ? ` (+${vinc.provas.length - 1})` : '';
      return {
        cor: 'amarelo', titulo: 'Concorrente',
        txt: 'contato vem de agência',
        sub: `${p.txt}${mais}${vinc.dominioDiferente ? ' · domínio ≠ site do lead' : ''}`,
        pendente: 'concorrente',
      };
    }

    if (m.is_concorrente === false) {
      if (!identificada) {
        return { cor: 'amarelo', titulo: 'Concorrente', txt: 'não classificável',
          sub: 'empresa não identificada — não dá pra afirmar o ramo', pendente: 'concorrente' };
      }
      return { cor: 'verde', titulo: 'Concorrente', txt: 'não é agência' };
    }
    return { cor: 'amarelo', titulo: 'Concorrente', txt: 'não determinado', pendente: 'concorrente' };
  }

  function boxEmpresa(entry) {
    const m = entry.m2 || entry.m1 || {};
    const temCnpj = !!(entry.oficial && entry.oficial.cnpj);

    // v18.0: a investigação trouxe outra empresa — o prefixo do cadastro não bate
    if (entry.cnpjErrado) {
      return {
        cor: 'amarelo', titulo: 'Empresa',
        txt: 'CNPJ achado é de outra empresa',
        sub: entry.cnpjErrado.texto,
        pendente: 'empresa',
      };
    }

    // v14.1: a IA achou uma marca nacional para um lead de porte PME
    const marca = checarMarcaNacional(entry.extracted.nomeEmpresa, entry.extracted.faturamentoMin);
    entry.marcaNacional = marca;
    if (marca && !temCnpj) {
      return {
        cor: 'amarelo', titulo: 'Empresa',
        txt: 'homônima de marca nacional',
        sub: 'o rastro achado é da marca grande — a empresa do lead é outra',
        pendente: 'empresa',
      };
    }

    // v15.0/15.1: o enriquecimento do LeadBroker já respondeu essa pergunta —
    // e vale nos DOIS sentidos. Caso real: o LB disse "CNPJ ativo confirmado em
    // 2 fontes com alta confiança" e o card mostrava "empresa não existe".
    const en = entry.enriq;
    if (en && en.empresaConfirmada === true) {
      return {
        cor: 'verde', titulo: 'Empresa',
        txt: temCnpj ? 'existe · CNPJ ativo' : 'existe · confirmada pelo LeadBroker',
        sub: en.cnpjAtivo ? 'CNPJ ativo nas fontes do LB' : 'cadastro confirmado pelo LB',
      };
    }
    if (en && en.empresaConfirmada === false && !temCnpj) {
      return {
        cor: en.hipotetico ? 'vermelho' : 'amarelo',
        titulo: 'Empresa',
        txt: en.hipotetico ? 'o LeadBroker não achou' : 'cadastro não confirmado',
        sub: `enriquecimento: ${en.negativas} de ${en.secoes.length} seções sem confirmação`,
        pendente: en.hipotetico ? null : 'empresa',
      };
    }

    if (m.empresa_existe === 'sim') {
      const fo = contarFontes(entry);
      return {
        cor: 'verde', titulo: 'Empresa',
        txt: temCnpj ? 'existe · CNPJ ativo' : 'existe · rastro online',
        sub: fo.rotulo(fo.empresa),   // v16.0: quantas provas independentes
      };
    }
    if (m.empresa_existe === 'nao') {
      // v16.7: se o contato é sócio de uma empresa que a investigação achou,
      // existe rastro — a razão social pode ser outra que o nome fantasia.
      // Caso NO ALVO: card dizia "empresa não existe" e "dono de 1 empresa".
      const oe = entry.outrasEmpresas;
      const comVinculo = oe && oe.lista && oe.lista.length;
      if (comVinculo) {
        const e1 = oe.lista[0];
        return {
          cor: 'amarelo', titulo: 'Empresa',
          txt: 'razão social pode ser outra',
          sub: `contato é sócio de ${String(e1.nome).slice(0, 40)} — confirmar se é a mesma operação`,
          pendente: 'empresa',
        };
      }
      // v20.0: com dígitos do CNPJ no cadastro, "não existe" é forte demais —
      // a empresa está registrada, só não foi achada. E o prefixo é o caminho
      // mais curto pra resolver na ligação.
      const px = (entry.extracted || {}).cnpjParcial;
      if (px && px.length >= 4) {
        return {
          cor: entry.m2 ? 'vermelho' : 'amarelo', titulo: 'Empresa',
          txt: 'não localizada pelo CNPJ do cadastro',
          sub: `o cadastro traz ${fmtPrefixo(px)} e a busca não achou nenhuma empresa `
             + `com esse início — peça o CNPJ na abertura`,
          pendente: 'empresa',
        };
      }

      return entry.m2
        ? { cor: 'vermelho', titulo: 'Empresa', txt: 'não existe · busca esgotada' }
        : { cor: 'amarelo', titulo: 'Empresa', txt: 'não localizada — investigar', pendente: 'empresa' };
    }
    return { cor: 'amarelo', titulo: 'Empresa', txt: 'parcial — investigar', pendente: 'empresa' };
  }

  function boxDecisor(entry) {
    const m = entry.m2 || entry.m1 || {};
    const ex = entry.extracted;

    // v14.6: quando o lead não traz o nome, o e-mail costuma trazer:
    // valdecy98@gmail.com → Valdecy · mauro@koraicho.me → Mauro.
    // O parseEmail já extraía isso e ninguém usava.
    const ei = ex.emailInfo;
    // "contato@", "financeiro@", "vendas@" não são nomes de pessoa. E dígitos
    // colados ("valdecy98") sujam a busca — tira.
    const CAIXA_GERAL = /^(contato|comercial|financeiro|vendas?|atendimento|sac|adm|admin|diretoria|rh|compras|faturamento|suporte|info|falecom|orcamento|marketing|empresa|loja|equipe|time|geral|no ?reply)$/i;
    const limparNome = (n) => {
      if (!n) return null;
      const s = String(n).replace(/\d+/g, '').trim();
      if (s.length < 3 || CAIXA_GERAL.test(s)) return null;
      return s;
    };
    const nomeE = limparNome(ei && ei.nomeExtraido);
    const sobrE = limparNome(ei && ei.sobrenomeExtraido);
    const nomeDoEmail = nomeE ? [nomeE, sobrE].filter(Boolean).join(' ') : null;

    if (!ex.nomeContato) {
      const soc = (entry.oficial && entry.oficial.qsa) || [];
      if (nomeDoEmail) {
        // dá pra investigar, só não é o nome declarado
        const bateQsa = soc.some(s => normalizarTexto(s.nome).includes(normalizarTexto(nomeE)));
        return {
          cor: 'amarelo', titulo: 'Decisor',
          txt: bateQsa ? `"${cap(nomeDoEmail)}" bate com o QSA` : `"${cap(nomeDoEmail)}" (pelo e-mail)`,
          sub: bateQsa ? 'nome do e-mail coincide com um sócio — confirmar' : 'o lead não trouxe o nome; este vem do e-mail',
          pendente: 'decisor',
        };
      }
      return { cor: 'amarelo', titulo: 'Decisor', txt: 'contato não informado no lead',
        sub: soc.length ? `QSA: ${soc[0].nome}` : 'marque o bloco todo do lead', pendente: 'decisor' };
    }
    // v15.1: o LB confirmou o decisor? Vale como prova, igual ao QSA.
    const enD = entry.enriq;
    if (enD && enD.decisorConfirmado === true && !entry.qsaMatch) {
      const s = (enD.secoes.find(x => x.chave === 'decisor') || {}).texto || '';
      const socioUnico = /s[óo]cio.?administrador [úu]nico|[úu]nico s[óo]cio/i.test(s);
      return {
        cor: 'verde', titulo: 'Decisor',
        txt: socioUnico ? 'é sócio · administrador único' : 'confirmado pelo LeadBroker',
        sub: 'LeadBroker identificou o contato como decisor',
      };
    }

    // v16.0: em empresário individual a razão social É o nome da pessoa.
    // Se o nome do contato está na razão social, ele é o dono — prova direta.
    const nat = entry.natureza;
    if (nat && nat.individual && nat.contatoEhDono && !entry.qsaMatch) {
      return {
        cor: 'verde', titulo: 'Decisor',
        txt: 'é o dono · empresário individual',
        sub: `razão social é o nome dele (${String(nat.razao || '').slice(0, 34)})`,
      };
    }

    const q = entry.qsaMatch;
    const par = entry.parentesco;
    if (q) {
      // v16.5: o matchQsa já calcula a confiança do cruzamento. Sócio confirmado
      // na Receita com confiança alta é o dado mais forte que existe — colocar
      // uma camada extra de desconfiança em cima disso deixava sócio legítimo
      // em amarelo (caso ALPHATECH, Kaique Alves como Sócio-Administrador).
      const alta = q.confianca === 'alta';

      const provas = [];
      if (normNome(ex.nomeContato || '') === normNome(q.socio.nome || '')) {
        provas.push('nome idêntico ao do QSA');
      } else if (q.viaEmail) {
        // v21.2: a cadeia que confirmou — o nome do e-mail bateu com o sócio
        provas.push(`${q.socio.nome} · e-mail confere`);
      } else {
        provas.push('nome bate no QSA');
      }
      // v21.2: o CNPJ do cadastro conferindo é a terceira prova da cadeia
      if (entry.cnpjConfirmado) provas.push('CNPJ do cadastro confere');

      // corroborações independentes, quando existem
      const eiQ = ex.emailInfo;
      const dom = eiQ && eiQ.corporativo ? normalizarTexto(eiQ.dominio).replace(/[^a-z0-9]/g, '') : '';
      const emp = normalizarTexto(ex.nomeEmpresa || '').replace(/[^a-z0-9]/g, '');
      if (dom && emp && (emp.includes(dom) || dom.includes(emp))) provas.push('e-mail do domínio da empresa');
      const cc = entry.contatoCadastro;
      if (cc && cc.provas >= 2) provas.push('cadastro confere');

      return {
        cor: alta ? 'verde' : 'amarelo',
        titulo: 'Decisor',
        txt: `é sócio · ${q.socio.qualificacao || 'QSA'}`,
        sub: alta ? provas.slice(0, 2).join(' + ')
                  : `match parcial no QSA (${q.socio.nome}) — confirme na ligação`,
        pendente: alta ? null : 'decisor',
      };
    }

    // v11.5: a IA às vezes devolve "Não identificado" no campo do cargo, e o
    // script tratava como se fosse um cargo real.
    const semCargo = (v) => {
      const t = normalizarTexto(v);
      return !t || /^(nao |sem |desconhec|indefinid|n\/?a$|\?|-)/.test(t)
          || /^(nao identificad|nao confirmad|nao encontrad|nao informad|nao localizad|nao consta)/.test(t);
    };

    // v17.6: se a evidência do decisor é uma negação, o cargo não confirma nada.
    // "Sócio-Administrador" com evidência "não há evidências que vinculem o
    // contato ao QSA" estava dando verde pelo caminho do cargo.
    const evidCrua = String(m.decisor_evidencia || '');
    const evidNega = !!evidCrua && ehNegacao(evidCrua);

    // v21.1: o QSA é da Receita; a evidência negativa é da busca. Se a Receita
    // confirma o sócio, "não há informações sobre o contato" não invalida nada —
    // só diz que a busca não achou. Caso EVOLUTION: sócio no QSA e o box dizia
    // "prova inválida · a evidência nega o vínculo".
    const qsaConfirma = !!(q && q.confianca !== 'baixa');
    const evRuim = qsaConfirma ? null
      : (checarEvidenciaDecisor(m) || (evidNega ? { tipo: 'a evidência nega o vínculo' } : null));
    let bruto = String(m.decisor_papel || '').trim();

    // v17.13: "Indício de sócio/proprietário ou alto cargo gerencial" não é um
    // cargo — é uma suposição. Caso REQUINTE: a IA inferiu pelo e-mail
    // corporativo e disse no mesmo texto que não achou QSA nem LinkedIn.
    // Hedge no cargo = cargo não confirmado.
    const CARGO_SUPOSTO = /\b(ind[íi]cio|indicativo|sugere|prov[áa]ve\w*|poss[íi]ve\w*|presum\w*|aparenta|parece|pode ser|talvez|estimad\w*|inferid\w*|suposto|suposi)\w*\b|\bou\s+(alto|outro|algum)\b/i;

    // v17.4: a IA às vezes devolve o cargo já se negando —
    // "Sócio (declarado, não confirmado por fonte externa)". O código lia só o
    // "Sócio" e dava verde. Se o parêntese nega, o cargo não está confirmado.
    const NEGA_NO_CARGO = /\((?=[^)]*\b(declarad|n[ãa]o confirmad|n[ãa]o verificad|a confirmar|suposto|presumid|sem confirma|plaus[íi]vel|prov[áa]vel))[^)]*\)/i;
    const cargoSeNega = NEGA_NO_CARGO.test(bruto) || CARGO_SUPOSTO.test(bruto);
    if (cargoSeNega) bruto = bruto.replace(/\s*\([^)]*\)\s*/g, ' ').trim();

    // v13.1: cargo em OUTRA empresa não dá alçada nesta. Caso real: Jose Nelio
    // é Sócio-Administrador da JFC Vanço Construção Civil (Cianorte), mas o lead
    // é a JFC Consultoria (Maringá). O box ficava VERDE dizendo "não é sócio ·
    // Sócio-Administrador" — contraditório e errado.
    const OUTRA_EMPRESA = /\b(em|de|na|numa|noutra)\s+outra\s+empresa|outra\s+empresa|empresa\s+(distinta|diferente)|homônim/i;
    const cargoEmOutra = OUTRA_EMPRESA.test(bruto)
      || OUTRA_EMPRESA.test(String(m.decisor_evidencia || ''));

    const cargo = (evRuim || semCargo(bruto) || cargoEmOutra || cargoSeNega) ? null : bruto;

    // v17.5: o cargo não confirmado não pode aparecer como fato. "Sócio ·
    // declarado" ainda passava a impressão de que ele é sócio. Agora o título
    // diz que NÃO está confirmado, e o cargo vem entre aspas na linha de baixo,
    // como alegação — igual ao faturamento declarado.
    if (cargoSeNega && bruto && !q) {
      return {
        cor: 'amarelo', titulo: 'Decisor',
        txt: 'cargo não confirmado',
        sub: `a investigação diz "${bruto}", mas sem evidência — pergunte na abertura`,
        pendente: 'decisor',
      };
    }

    // v14.0: dono de CNPJ é decisor. Se a empresa achada é a do lead, ou fica na
    // mesma cidade, ou leva o sobrenome dele, isso é qualidade — não ressalva.
    const oe = avaliarOutrasEmpresas(entry);
    entry.outrasEmpresas = oe;

    // v16.9: se a investigação citou o CNPJ DESTA empresa ou o QSA dela ao
    // falar do decisor, isso é prova direta e vence a lista de homônimos.
    // Caso C-REIS: a busca disse "O CNPJ 42.328.219/0001-64 lista Luiz como
    // sócio-administrador" e o box mostrou "não confirmado · 7 homônimos".
    const cnpjLead = String((entry.oficial && entry.oficial.cnpj) || '').replace(/\D/g, '');
    // v17.6: só a parte AFIRMATIVA da evidência pode confirmar
    const evid = soAfirmativo(String(m.decisor_evidencia || '')) + ' '
               + soAfirmativo(String(m.decisor_papel || ''));
    // v17.4: a evidência pode CITAR o QSA dentro de uma negação —
    // "não há evidências externas (QSA, LinkedIn, site) que vinculem X".
    // Caso HORTIFRUTI: o box ficava verde dizendo "confirmou no CNPJ" com o
    // texto embaixo dizendo exatamente o contrário.
    const NEGA_VINCULO = /n[ãa]o h[áa] evid[êe]ncias?|n[ãa]o foi poss[íi]vel (confirmar|vincular|associar)|sem (evid[êe]ncia|confirma[çc][ãa]o|v[íi]nculo)|n[ãa]o confirmad[oa] por fonte|n[ãa]o (consta|aparece|vincula|localizad)|declarado, n[ãa]o confirmado/i;
    const evidNegada = NEGA_VINCULO.test(evid);

    const citaEsteCnpj = !evidNegada && !!(cnpjLead && evid.replace(/\D/g, '').includes(cnpjLead));
    const citaQsaDaqui = !evidNegada
      && /\bQSA\b|quadro societ[áa]rio|consta como s[óo]cio (desta|da empresa)/i.test(evid);

    // o primeiro nome do contato aparece em algum sócio do QSA?
    const qsaLista = (entry.oficial && entry.oficial.qsa) || [];
    const pc = partesNome(ex.nomeContato || '');
    const noQsa = pc.length > 0 && qsaLista.find(s =>
      pc.every(p => normalizarTexto(s.nome).split(/\s+/).includes(p)));

    if ((citaEsteCnpj || citaQsaDaqui) && CARGO_SOCIO.test(bruto)) {
      return {
        cor: 'verde', titulo: 'Decisor',
        txt: `é sócio · ${bruto.replace(/\s*\(.*?\)\s*/g, '').trim()}`,
        sub: noQsa ? `confirmado no QSA (${noQsa.nome})` : 'a investigação confirmou no CNPJ da empresa',
      };
    }

    // v21.2: primeiro nome batendo com algum sócio do QSA já é indício de que
    // o contato é sócio. Caso EVOLUTION: contato "Eduardo", QSA com
    // "EDUARDO ANACLETO DA CRUZ", e o box dizia "prova inválida" — como se
    // não houvesse nada. O nome do sócio tem que aparecer.
    if (!q && Array.isArray((entry.oficial || {}).qsa) && entry.oficial.qsa.length) {
      const pc = partesNome(ex.nomeContato || '');
      if (pc.length) {
        const cand = entry.oficial.qsa.filter(s => {
          const ps = partesNome(s.nome || '');
          return ps.length && ps[0] === pc[0];
        });
        if (cand.length) {
          // a cadeia de provas: nome, e-mail, CNPJ
          const provas = ['primeiro nome bate'];
          const ei = ex.emailInfo;
          const doEmail = ei && [ei.nomeExtraido, ei.sobrenomeExtraido].filter(Boolean).join(' ');
          if (doEmail) {
            const pe = partesNome(doEmail);
            const juntas = partesNome(cand[0].nome).join('');
            const semPart = p => p.replace(/^(da|de|do|das|dos|e)/, '') || p;
            if (pe.length >= 2 && pe.every(p => juntas.includes(p) || juntas.includes(semPart(p)))) {
              provas.push('e-mail confere');
            }
          }
          if (entry.cnpjConfirmado) provas.push('CNPJ do cadastro confere');

          const forte = provas.length >= 2;
          return {
            cor: forte ? 'verde' : 'amarelo',
            titulo: 'Decisor',
            txt: forte ? `é sócio · ${cand[0].qualificacao || 'QSA'}`
                       : `provável sócio · ${cand[0].nome}`,
            sub: forte ? `${cand[0].nome} · ${provas.slice(1).join(' · ')}`
                       : (cand.length > 1
                          ? `${cand.length} sócios com esse primeiro nome — sem confirmação independente`
                          : 'só o primeiro nome bate — sem confirmação independente'),
            pendente: forte ? null : 'decisor',
          };
        }
      }
    }

    // v14.3: homônimo em série não é empresário — e o parentesco no QSA, que é
    // sinal de verdade, tem prioridade sobre a lista de empresas achadas.
    if (oe && oe.homonimos && par) {
      return {
        cor: 'amarelo', titulo: 'Decisor',
        txt: `possível familiar · ${par.sobrenomes}`,
        sub: 'sobrenome bate com o do sócio — cônjuge ou parente que toca o negócio',
        pendente: 'decisor',
      };
    }
    if (oe && oe.homonimos) {
      return {
        cor: 'amarelo', titulo: 'Decisor',
        txt: 'não confirmado',
        sub: `${oe.descartadas.length} empresa${oe.descartadas.length > 1 ? 's' : ''} com nome parecido, `
           + 'nenhuma ligada a esta — só o nome do contato batia',
        pendente: 'decisor',
      };
    }

    if (oe && oe.ehDono) {
      // v16.10: a IA marcar uma empresa como "a do lead" significa que ela
      // ACHOU a empresa — não que o contato seja sócio dela. Caso FM COMÉRCIO:
      // QSA tinha Vitor Hugo Perin, contato era Rodrigo Perin, e a própria
      // investigação disse "não foi possível confirmar se é a mesma pessoa".
      // Mesmo assim o box saía verde dizendo "sócio da empresa do lead".
      if (oe.aDoLead && !entry.qsaMatch) {
        const naoConfirma = /n[ãa]o foi poss[íi]vel confirmar|mesma pessoa|sem (confirma|v[íi]nculo)/i
          .test(String(m.decisor_evidencia || ''));
        const socioNome = (entry.oficial && entry.oficial.qsa && entry.oficial.qsa[0])
          ? entry.oficial.qsa[0].nome : null;
        if (naoConfirma || socioNome) {
          return {
            cor: 'amarelo', titulo: 'Decisor',
            txt: par ? `possível familiar · ${par.sobrenomes}` : 'não confirmado',
            sub: socioNome
              ? `o sócio é ${socioNome} — confirme a relação do contato com ele`
              : 'a empresa foi achada, mas o vínculo do contato não',
            pendente: 'decisor',
          };
        }
      }

      const primeira = oe.aDoLead || oe.lista[0];
      const forte = primeira._prova.forca === 'definitiva' || primeira._prova.forca === 'forte';
      const outros = oe.total > 1 ? ` (+${oe.total - 1})` : '';
      return {
        cor: forte ? 'verde' : 'amarelo',
        titulo: 'Decisor',
        txt: oe.aDoLead
          ? `é sócio · ${primeira.papel || 'sócio'}`
          : `dono de ${oe.total} empresa${oe.total > 1 ? 's' : ''}${outros ? '' : ''}`,
        sub: oe.aDoLead
          ? 'sócio da empresa do lead'
          : `${esc(primeira.nome)}${primeira.cidade ? ' · ' + esc(primeira.cidade) : ''}${outros}`
            + ` — ${primeira._prova.prova}`,
        pendente: forte ? null : 'decisor',
      };
    }

    if (cargoEmOutra && !q) {
      const limpo = bruto.replace(/\s*\(.*?\)\s*/g, '').trim() || 'sócio';
      return {
        cor: 'amarelo', titulo: 'Decisor',
        txt: `${limpo} de OUTRA empresa`,
        sub: 'sem vínculo comprovado com esta — confirmar na ligação',
        pendente: 'decisor',
      };
    }
    // v17.3: cargo SUBORDINADO confirmado é o único vermelho do decisor.
    // Analista, assistente, auxiliar e estagiário não aprovam contratação —
    // isso é informação ativa, diferente de "não sei quem decide".
    const SUBORDINADO = /\b(analista|assistente|auxiliar|estagi[áa]ri\w*|aprendiz|trainee|operador\w*|atendente|vendedor\w*|secret[áa]ri\w*|recepcionista|jovem aprendiz)\b/i;
    if (cargo && SUBORDINADO.test(cargo)) {
      return { cor: 'vermelho', titulo: 'Decisor', txt: `${cargo} — não decide`,
        sub: `o porte pede ${alcadaDoPorte(ex.faturamentoMin).rot}`, pendente: 'decisor' };
    }

    // v18.1: o cargo às vezes vem com o nome de QUEM ocupa —
    // "Presidente (Omar Tavares)" com o contato sendo Joao Tavares. Mesmo
    // sobrenome, pessoa diferente. O script lia "Presidente" e dava alçada.
    // Já tinha corrigido isso nas empresas do contato (v17.7); faltava aqui.
    if (cargo && ex.nomeContato) {
      const entreParenteses = String(bruto).match(/\(([^)]{5,})\)/);
      if (entreParenteses && /[a-zà-ú]{3,}\s+[a-zà-ú]{3,}/i.test(entreParenteses[1])) {
        const doContato = partesNome(ex.nomeContato).filter(p => p.length > 2);
        const doCargo = normalizarTexto(entreParenteses[1]).split(/\s+/).filter(p => p.length > 2);
        // o primeiro nome tem que bater — sobrenome igual não basta
        const primeiroBate = doContato.length && doCargo.length && doContato[0] === doCargo[0];
        if (doContato.length && doCargo.length && !primeiroBate) {
          const quem = entreParenteses[1].trim();
          return {
            cor: 'amarelo', titulo: 'Decisor',
            txt: 'o cargo é de outra pessoa',
            sub: `quem ocupa é ${quem} — o contato é ${ex.nomeContato}. Confirme o papel dele.`,
            pendente: 'decisor',
          };
        }
      }
    }

    const alc = temAlcada(cargo, ex.faturamentoMin);
    if (cargo && alc === true) return { cor: 'verde', titulo: 'Decisor',
      txt: cargo, sub: 'cargo tem alçada neste porte' };
    if (cargo && alc === false) return { cor: 'amarelo', titulo: 'Decisor',
      txt: `${cargo} — sem alçada`,
      sub: `o porte pede ${alcadaDoPorte(ex.faturamentoMin).rot}`, pendente: 'decisor' };
    if (par) return { cor: 'amarelo', titulo: 'Decisor', txt: `possível familiar · ${par.sobrenomes}`, sub: 'confirmar relação', pendente: 'decisor' };
    if (evRuim) return { cor: 'amarelo', titulo: 'Decisor', txt: 'prova inválida', sub: evRuim.tipo, pendente: 'decisor' };

    // v17.3: "não encontrado" era vermelho depois do M2 e amarelo antes — a cor
    // dependia de quanto tempo a investigação teve, não da evidência. E o
    // caminho dos homônimos devolvia amarelo no mesmo estado (caso FRPARTSGYN).
    // Agora é sempre AMARELO: não saber quem decide é lacuna a resolver na
    // ligação, não motivo pra descartar o lead.
    return { cor: 'amarelo', titulo: 'Decisor',
      txt: 'não confirmado',
      sub: entry.m2 ? 'a investigação não achou o vínculo — pergunte na abertura'
                    : 'aprofunde ou confirme na ligação',
      pendente: 'decisor' };
  }

  function boxMargem(entry) {
    const m = entry.m2 || entry.m1 || {};
    const ex = entry.extracted;
    const cnae = entry.oficial && entry.oficial.cnae;
    // v15.1: se a investigação não achou o ramo mas o LB descreveu, usa o do LB
    const ramoLB = entry.enriq && entry.enriq.ramo;
    const ramoIA = (entry.m2 && entry.m2.ramo_real) || m.ramo_aparente || ramoLB || null;

    // v14.12: o CNAE é o que a empresa REGISTROU, não o que faz hoje. Caso real:
    // Coimbra Company tem CNAE de peças eletrônicas e o site é de infoproduto —
    // margem baixa vs alta. Duas formas de perceber:
    //   a) CNAE e atividade investigada caem em buckets diferentes
    //   b) a própria IA apontou a divergência nas contradições (foi o que houve)
    const bCnae = cnae ? classificarMargem(cnae) : null;
    const bIA = ramoIA ? classificarMargem(ramoIA) : null;

    // v16.10: quando o ramo investigado REPETE o texto do CNAE (com um adendo
    // entre parênteses, por exemplo), não há divergência nenhuma — é a mesma
    // informação. Caso FM COMÉRCIO: CNAE "comércio a varejo de peças para
    // veículos" e ramo "comércio a varejo de peças para veículos (ar
    // condicionado para caminhões)", e o "ar condicionado" puxava a
    // classificação pra serviços técnicos.
    const nCnae = normalizarTexto(String(cnae || '').replace(/^\d+\s*/, ''));
    const nRamo = normalizarTexto(String(ramoIA || ''));
    const repeteCnae = !!(nCnae.length > 20 && nRamo.length > 20
      && (nRamo.includes(nCnae.slice(0, 40)) || nCnae.includes(nRamo.slice(0, 40))));

    const porBucket = !!(bCnae && bIA && bCnae.bucket !== bIA.bucket && !repeteCnae);

    const flags = [].concat(m.contradicoes || [], m.red_flags || []).map(String).join(' | ');
    const porFlag = !!cnae && /cnae[^|]*(n[ãa]o (reflete|corresponde|condiz)|diverge|difere|desatualizad)/i.test(flags);

    if (porBucket || porFlag) {
      entry.margemDivergente = {
        cnae: bCnae, real: bIA,
        via: porBucket ? 'bucket' : 'a própria investigação apontou',
      };
      return {
        cor: 'amarelo', titulo: 'Margem',
        txt: porBucket ? `${bCnae.rot} (CNAE) vs ${bIA.rot} (real)` : 'CNAE não reflete a atividade',
        sub: porBucket
          ? `CNAE diz "${bCnae.nome}", investigação diz "${bIA.nome}"`
          : 'a investigação achou atividade diferente do registro — confirmar',
        motivo: bCnae && bIA
          ? `CNAE indica ${bCnae.nome}, investigação indica ${bIA.nome}`
          : 'CNAE desatualizado — a atividade real é outra',
        pendente: 'margem',
      };
    }

    const ramo = cnae || ramoIA;
    entry.ramoFonte = cnae ? 'CNAE' : (ramoIA ? 'investigação' : null);

    const ramoVerif = !!cnae || (!!ramoIA && !entry.marcaNacional);
    const cp = entry.coerenciaPorte;
    const fatVerif = !!(cp && cp.checou && cp.coerente === true);
    const fatContradiz = !!(cp && cp.checou && cp.coerente === false);

    const r = cruzarMatriz(ramo, ex.faturamentoMin, ramoVerif, fatVerif, fatContradiz);
    entry.matriz = r;

    // v16.6: primeira linha = o dado seco. Segunda = o corte de ICP do bucket,
    // que é o número que o SDR precisa pra decidir na hora.
    let sub;
    if (!r.marg) {
      sub = r.curto || r.motivo;
    } else {
      const c = corteICP(r.marg.bucket);
      if (r.cor === 'verde') {
        sub = ['porte acima do corte', cnae ? 'via CNAE' : ''].filter(Boolean).join(' · ');
      } else if (c) {
        sub = `ICP a partir de ${c.texto}/mês`;
        // quando há ressalva além do porte, ela vem junto
        if (r.curto && !/abaixo de|sem faturamento/i.test(r.curto)) sub += ` · ${r.curto}`;
      } else {
        sub = r.curto || r.motivo;
      }
    }

    return {
      cor: r.cor, titulo: 'Margem',
      txt: r.marg ? `${r.marg.rot} · ${r.marg.nome}` : 'não classificada',
      sub,
      motivo: r.motivo,
    };
  }

  function calcularFarol(entry) {
    const bs = { concorrente: boxConcorrente(entry), empresa: boxEmpresa(entry),
                 decisor: boxDecisor(entry), margem: boxMargem(entry) };
    entry.boxes = bs;
    if (bs.concorrente.veta) return { cor: 'vermelho', rot: 'CONCORRENTE', luz: '🚨', conc: true, motivo: 'é agência de marketing', boxes: bs };
    const ordem = ['empresa', 'margem', 'decisor'];
    const k = ordem.find(x => bs[x].cor === 'vermelho');
    if (k) {
      const mot = { empresa: 'empresa não existe', margem: bs.margem.motivo, decisor: 'decisor não encontrado' };
      return { cor: 'vermelho', rot: 'STOP', luz: '🔴', motivo: mot[k], boxes: bs };
    }
    const am = Object.entries(bs).filter(([, b]) => b.cor === 'amarelo');
    if (am.length) return { cor: 'amarelo', rot: 'CAUTION', luz: '🟡', motivo: am.map(([x]) => x).join(' · '), boxes: bs };
    return { cor: 'verde', rot: 'GO', luz: '🟢', motivo: null, boxes: bs };
  }

  // ═══════════════════════════════════════════════════════════════
  // MATRIZ MARGEM × FATURAMENTO (v11.0)
  // Substitui o cálculo de EBITDA × WTP. Classificação por bucket de margem
  // cruzada com faixa de faturamento — direto ao veredito, sem estimar número.
  // Tiny (< R$ 100k) fica fora da matriz.
  // ═══════════════════════════════════════════════════════════════
  const BUCKETS = {
    alta:  { rot: 'alta',  faixa: '>50%' },
    media: { rot: 'média', faixa: '30-50%' },
    baixa: { rot: 'baixa', faixa: '<30%' },
  };

  const MARGEM_SEGMENTO = [
    // ─── ALTA (>50%)
    // v17.6: SCD, fintech de crédito e factoring apareceram no histórico e não
    // classificavam. Intermediação financeira tem margem alta e ticket alto.
    { re: /sociedade de cr[ée]dito|\bSCD\b|fintech|institui[çc][ãa]o de pagamento|correspondente banc[áa]rio|factoring|securitizadora|intermedia[çc][ãa]o (financeira|n[ãa]o.?monet[áa]ria)|cr[ée]dito direto|\bBaaS\b|meios? de pagamento|adquirente|subadquirente/i, b: 'alta', nome: 'serviços financeiros' },
    { re: /consultori|assessori(a|as)? (empresarial|comercial|financeira|de gest)|advocac|advogad|advocat[íi]ci|jur[íi]dic|contabil|contador|atividades de contabilidade|gest[ãa]o empresarial/i, b: 'alta', nome: 'serviços profissionais' },
    { re: /cl[íi]nic|consult[óo]rio|m[ée]dic|odontolog|dentist|fisioterap|psicolog|nutric|dermatolog|cirurgia pl[áa]stic|cirurgi[ãa]o pl[áa]stic|veterinari|atividade m[ée]dica|laborat[óo]rio (cl[íi]nic|de an[áa]lises)|complementa[çc][ãa]o diagn/i, b: 'alta', nome: 'clínica / saúde' },
    { re: /est[ée]tic|harmoniza|botox|preenchim|injet[áa]v|laser|depila|micropigment/i, b: 'alta', nome: 'estética' },
    { re: /software|saas|sistema de gest|erp\b|plataforma|aplicativo|tecnolog|desenvolvimento (de|e licenciamento de) programas|f[áa]brica de software|infoproduto|curso online|neg[óo]cio digital|portais? provedores?|consultoria em tecnologia|provedor de internet|telecomunica[çc][õo]es|scm\b|servi[çc]os de comunica[çc][ãa]o multim[íi]dia|esports?|esportes eletr[ôo]nicos/i, b: 'alta', nome: 'software / digital' },
    { re: /arquitetur|design|engenharia consultiv|per[íi]ci|auditori|corretora de seguro|seguros/i, b: 'alta', nome: 'serviços técnicos especializados' },
    { re: /home care|cuidador|assist[êe]ncia domiciliar|vacina[çc][ãa]o/i, b: 'alta', nome: 'saúde domiciliar' },
    { re: /ag[êe]ncias? de publicidade|marketing direto|consultoria em publicidade|marketing digital|promo[çc][ãa]o de vendas|7319002/i, b: 'alta', nome: 'agência de publicidade' },

    // ─── MÉDIA (30-50%)
    { re: /e-?commerce (de )?marca pr[óo]pria|marca pr[óo]pria|d2c|ateli[êe]|artesanal|feito [àa] m[ãa]o|produ[çc][ãa]o pr[óo]pria/i, b: 'media', nome: 'e-commerce marca própria' },
    { re: /e-?commerce|loja (virtual|online)|com[ée]rcio eletr[ôo]nic|venda online|shopee|mercado livre/i, b: 'media', nome: 'e-commerce' },
    { re: /educac|escola|col[ée]gio|faculdad|universidad|ensino|idioma|curso (livre|profissionaliz|t[ée]cnic)|treinamento (corporativ|profissional|gerencial)|capacita[çc][ãa]o profissional/i, b: 'media', nome: 'educação' },
    { re: /logistic asset.?light|agenciamento de carga|broker de frete|gest[ãa]o de frete/i, b: 'media', nome: 'logística asset-light' },
    { re: /manuten[çc][ãa]o e repara[çc][ãa]o|manutenc|instalac|instala[çc][ãa]o de m[áa]quinas|servic(o|os) t[ée]cnic|assist[êe]ncia t[ée]cnic|oficina|mec[âa]nic|reparo|conserto|climatiza|refrigera[çc][ãa]o|ar.?condicionado|el[ée]tric|hidr[áa]ulic|estacionamento|lava.?r[áa]pido/i, b: 'media', nome: 'serviços técnicos' },
    { re: /ind[úu]stria (de )?(cosm[ée]tic|farmac|equipament|m[áa]quina|instrument|[óo]ptic|eletr[ôo]nic)|manufatura diferenciad/i, b: 'media', nome: 'indústria diferenciada' },
    { re: /academia|est[úu]dio (de )?(fitness|pilates|crossfit)|pilates|crossfit|personal|condicionamento f[íi]sic|instala[çc][õo]es de esporte/i, b: 'media', nome: 'fitness' },
    { re: /restaurant|food service|lanchonet|pizzari|hamburgu|cafeteria|padari|confeitar|buffet|delivery de comida|servi[çc]os? de alimenta[çc][ãa]o|rotisserie|comida (congelada|pronta)|massas? (artesanais|frescas)|pratos? prontos?|antepasto|marmit|a[çc]a[íi]/i, b: 'media', nome: 'food service' },
    { re: /hot[ée](l|is)|pousada|hospedag|turism|ag[êe]ncia de viage|motel|albergue|aluguel de [ôo]nibus|fretamento|organiza[çc][ãa]o de eventos/i, b: 'media', nome: 'turismo / hotelaria' },
    { re: /imobiliar|corretag|incorporador|loteament/i, b: 'media', nome: 'imobiliário' },
    { re: /sal[ãa]o de beleza|barbear|cabeleire|manicure|spa\b|pedicure/i, b: 'media', nome: 'beleza' },
    { re: /recrutament|recursos human|headhunt|contact center|bpo|apoio administrativ|prepara[çc][ãa]o de documento/i, b: 'media', nome: 'RH / BPO' },
    { re: /pet ?shop|banho e tosa|agropet|loja de ra[çc][ãa]o/i, b: 'media', nome: 'pet' },
    { re: /[óo]tica|[óo]culos|joalheri|semij[óo]ia|rel[óo]joari/i, b: 'media', nome: 'varejo de alto markup' },
    { re: /gr[áa]fica|impress[ãa]o|comunica[çc][ãa]o visual|sinaliza[çc][ãa]o|plotage|serigrafi/i, b: 'media', nome: 'comunicação visual' },
    { re: /energia solar|fotovoltaic|painel solar|efici[êe]ncia energ/i, b: 'media', nome: 'energia solar' },
    { re: /lavanderia|chaveiro|copiadora|servi[çc]os pessoais/i, b: 'media', nome: 'serviços de bairro' },
    { re: /ind[úu]stria|manufatur|f[áa]brica|fabrica[çc][ãa]o|metalurg|usinag|confecc|artefatos? de|injec[çã]|extrus|estampari|fundi[çc][ãa]o/i, b: 'media', nome: 'indústria' },

    // ─── BAIXA (<30%)
    { re: /farmac|drogaria|produtos farmac|medicament/i, b: 'baixa', nome: 'farmácia / drogaria' },
    { re: /supermerc|minimerc|mercearia|atacarej|hipermerc|mercadorias em geral|produtos aliment[íi]cios (em geral|especializado)|varejista de produtos aliment|hortifruti|hortigranjeir|sacol[ãa]o|quitanda|frutas, legumes|feira livre|empor[íi]o de aliment/i, b: 'baixa', nome: 'varejo alimentar' },
    { re: /distribuidor|distribui[çc][ãa]o|atacad|atacadist|represent(a[çc][ãa]o|ante) comercial/i, b: 'baixa', nome: 'distribuição / atacado' },
    { re: /revend|marketplace|dropship|importa[çc][ãa]o e revend/i, b: 'baixa', nome: 'revenda' },
    { re: /ind[úu]stria (de )?(commodit|a[çc]o|cimento|papel|celulose|gr[ãa]o|a[çc][úu]car|etanol)|commodit/i, b: 'baixa', nome: 'indústria commodity' },
    { re: /transportador|transporte (de |rodovi[áa]rio de )?carga|frota|frete rodovi|log[íi]stica (intensiv|de armazen)|armazenag|entrega r[áa]pida|motoboy/i, b: 'baixa', nome: 'logística intensiva em ativos' },
    { re: /materia(l|is) de constru|autope[çc]|pneu|combust[íi]vel|posto de gasolina|ferragens? e ferramentas|material el[ée]tric/i, b: 'baixa', nome: 'revenda de volume' },
    { re: /agro|agr[íi]col|pecuar|fazend|lavour|gado|plantio/i, b: 'baixa', nome: 'agro' },
    { re: /loja de roupa|vestu[áa]rio|cal[çc]ad|moda|magazine|m[óo]veis|eletrodom[ée]stic|celular|acess[óo]rio|[áa]udio e v[íi]deo|papelaria|livraria|a[çc]ougue|bazar|presente|material fotogr[áa]fico|pe[çc]as de kart|artigos esportivos/i, b: 'baixa', nome: 'varejo não-alimentar' },
    { re: /limpeza|portaria|seguran[çc]a patrimonial|facilities|monitoramento de sistemas? de seguran|vigil[âa]ncia/i, b: 'baixa', nome: 'facilities / segurança' },
    { re: /constru(tora|[çc][ãa]o civil|[çc][ãa]o de edif)|empreiteir|obras de|incorpora[çc][ãa]o/i, b: 'baixa', nome: 'construção civil' },
    { re: /concession[áa]ri|com[ée]rcio de ve[íi]culos|autom[óo]ve(l|is)|seminov/i, b: 'baixa', nome: 'veículos' },
  ];

  const FAIXAS = [
    { min: 100000,  max: 200000,   rot: '100-200k' },
    { min: 200000,  max: 400000,   rot: '200-400k' },
    { min: 400000,  max: 1000000,  rot: '400k-1M'  },
    { min: 1000000, max: 4000000,  rot: '1-4M'     },
    { min: 4000000, max: Infinity, rot: '4M+'      },
  ];

  const MATRIZ = {
    alta:  ['verde',    'verde',    'verde',   'verde', 'verde'],
    media: ['vermelho', 'amarelo',  'verde',   'verde', 'verde'],
    baixa: ['vermelho', 'vermelho', 'amarelo', 'verde', 'verde'],
  };

  // v16.6: o corte de ICP não é número solto — sai da própria matriz.
  // Alta vira verde já em 100k; média a partir de 400k; baixa só em 1M.
  // Mostrar isso no box evita decorar a tabela na hora do lance.
  function corteICP(bucket) {
    const linha = MATRIZ[bucket];
    if (!linha) return null;
    const i = linha.indexOf('verde');
    if (i < 0) return null;
    const f = FAIXAS[i];
    return { faixa: f, texto: f.min >= 1000000 ? `R$ ${f.min / 1000000}M` : `R$ ${f.min / 1000}k` };
  }

  // v17.2: "Serviços de montagem de móveis" casava com "móveis" no regex de
  // varejo e virava varejo não-alimentar. Prestar serviço SOBRE um produto não
  // é vender o produto — é serviço técnico, com margem diferente.
  // Vale pra montagem, instalação, manutenção, reparo, conserto e assistência.
  const SERVICO_SOBRE_PRODUTO =
    /\b(servi[çc]os? de\s+)?(montagem|instala[çc][ãa]o|manuten[çc][ãa]o|repara[çc][ãa]o|reparo|conserto|assist[êe]ncia t[ée]cnica|limpeza|higieniza[çc][ãa]o|restaura[çc][ãa]o)\b/i;
  const VENDA_DE_PRODUTO =
    /\b(com[ée]rcio|venda|varejo|varejista|atacado|atacadista|revenda|loja|fabrica[çc][ãa]o|ind[úu]stria)\b/i;

  function classificarMargem(ramo) {
    if (!ramo) return null;
    // v17.6: "não há evidências de clínica médica" não é uma clínica
    if (ehNegacao(ramo)) return null;
    let limpo = soAfirmativo(ramo);

    // v17.13: o parêntese costuma listar CLIENTES ou variações, não o negócio.
    // "Fabricação de uniformes profissionais (segurança, hotelaria/cozinha/
    // restaurante, hospitalar)" é confecção — os restaurantes são clientes.
    // Se o texto FORA do parêntese já classifica, ele manda.
    const semParenteses = limpo.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if (semParenteses.length > 12 && semParenteses !== limpo.trim()) {
      const so = normalizarTexto(semParenteses);
      if (SERVICO_SOBRE_PRODUTO.test(so) && !VENDA_DE_PRODUTO.test(so)) {
        const tec = MARGEM_SEGMENTO.find(s => s.nome === 'serviços técnicos');
        if (tec) return { bucket: tec.b, nome: tec.nome, ...BUCKETS[tec.b] };
      }
      if (/\b(atacad|distribuidora?|comercio atacadista)\b/.test(so)) {
        const dist = MARGEM_SEGMENTO.find(s => s.nome === 'distribuição / atacado');
        if (dist) return { bucket: dist.b, nome: dist.nome, ...BUCKETS[dist.b] };
      }
      for (const m of MARGEM_SEGMENTO) {
        if (m.re.test(so)) return { bucket: m.b, nome: m.nome, ...BUCKETS[m.b] };
      }
    }

    const t = normalizarTexto(limpo);
    if (!t) return null;

    // v17.2: prestar serviço SOBRE um produto não é vender o produto.
    // "Serviços de montagem de móveis" casava com "móveis" e virava varejo.
    if (SERVICO_SOBRE_PRODUTO.test(t) && !VENDA_DE_PRODUTO.test(t)) {
      // nome EXATO — existe também "serviços técnicos especializados" (alta),
      // que é outra coisa: engenharia, projeto, laudo.
      const tec = MARGEM_SEGMENTO.find(s => s.nome === 'serviços técnicos');
      if (tec) return { bucket: tec.b, nome: tec.nome, ...BUCKETS[tec.b] };
    }

    // v17.2: atacado/varejo de um produto é comércio, não o setor do produto.
    // "Comércio atacadista de medicamentos" casava com "medicamentos" e virava
    // clínica/saúde — margem alta onde é distribuição, margem baixa.
    if (/\b(atacad|distribuidora?|comercio atacadista)\b/.test(t)) {
      const dist = MARGEM_SEGMENTO.find(s => s.nome === 'distribuição / atacado');
      if (dist) return { bucket: dist.b, nome: dist.nome, ...BUCKETS[dist.b] };
    }

    for (const m of MARGEM_SEGMENTO) if (m.re.test(t)) return { bucket: m.b, nome: m.nome, ...BUCKETS[m.b] };
    return null;
  }

  function faixaDeFaturamento(fatMin) {
    if (!fatMin) return null;
    const i = FAIXAS.findIndex(f => fatMin >= f.min && fatMin < f.max);
    return i < 0 ? null : { idx: i, ...FAIXAS[i] };
  }

  // Vermelho só com as duas pontas verificadas. Dado declarado informa, não veta.
  function cruzarMatriz(ramo, fatMin, ramoVerif, fatVerif, fatContradiz) {
    const marg = classificarMargem(ramo);
    const faixa = faixaDeFaturamento(fatMin);

    if (!marg && !faixa) {
      return { cor: 'amarelo',
        curto: 'sem ramo e sem faturamento',
        motivo: ramo ? 'ramo fora da régua e sem faturamento' : 'sem ramo nem faturamento — SDR confirma' };
    }
    if (!marg) {
      return { cor: 'amarelo', faixa,
        curto: ramo ? 'ramo fora da régua de margem' : 'ramo não identificado',
        motivo: ramo ? `"${String(ramo).slice(0,40)}" ainda não está na régua de margem` : 'ramo não identificado' };
    }
    if (!faixa) {
      const tiny = fatMin && fatMin < 100000;
      return { cor: 'amarelo', marg,
        curto: tiny ? 'abaixo de R$ 100k/mês' : 'sem faturamento',
        motivo: tiny ? 'abaixo de R$ 100k/mês — fora da matriz, SDR avalia caso a caso'
                     : 'sem o faturamento não dá pra dizer se compensa' };
    }

    const bruta = MATRIZ[marg.bucket][faixa.idx];

    // v11.2: dado não verificado não decide — nem pra vetar, nem pra aprovar.
    // Antes eu só exigia verificação pro vermelho. Um EPP declarando R$ 1M/mês
    // (teto legal R$ 400k) saía VERDE, quando o faturamento real cairia uma ou
    // duas faixas. Aprovar sem base custa mais que rejeitar: é o lance alto.
    if (bruta === 'vermelho' && !(ramoVerif && fatVerif)) {
      const falta = [];
      if (!fatVerif) falta.push('faturamento é declarado');
      if (!ramoVerif) falta.push('ramo não confirmado');
      const curto = !fatVerif && !ramoVerif ? 'faturamento e ramo não confirmados'
                  : !fatVerif ? 'faturamento não confirmado'
                  : 'ramo não confirmado';
      return { cor: 'amarelo', marg, faixa,
        curto: `seria STOP — ${curto}`,
        motivo: `${marg.rot} margem em ${faixa.rot} seria STOP, mas ${curto} — confirme antes de passar` };
    }

    if (bruta === 'verde' && !fatVerif) {
      // Qual seria a cor se o faturamento estiver inflado uma faixa pra baixo?
      // Na primeira faixa não há como descer dentro da matriz — só rebaixa se a
      // Receita CONTRADIZ o declarado, não por simples falta de confirmação.
      const abaixo = faixa.idx > 0 ? MATRIZ[marg.bucket][faixa.idx - 1]
                   : (fatContradiz ? 'vermelho' : 'verde');
      if (abaixo !== 'verde') {
        return {
          cor: 'amarelo', marg, faixa,
          curto: fatContradiz ? 'faturamento não bate com a Receita' : 'depende do faturamento declarado',
          motivo: fatContradiz
            ? 'o faturamento declarado não bate com a Receita — se for menor, o lead deixa de valer o lance'
            : 'só compensa se o faturamento declarado estiver certo — uma faixa abaixo já não vale',
        };
      }
    }

    const curto = bruta === 'verde' ? 'porte sustenta o investimento'
                : bruta === 'vermelho' ? `${marg.rot} margem em ${faixa.rot} não sustenta`
                : `${marg.rot} margem em ${faixa.rot} — avaliar`;
    return { cor: bruta, marg, faixa, curto,
      motivo: bruta === 'verde' ? `margem ${marg.rot} sustenta o investimento em ${faixa.rot}`
            : bruta === 'vermelho' ? `margem ${marg.rot} em ${faixa.rot} não sustenta o investimento comercial`
            : `margem ${marg.rot} em ${faixa.rot} — avaliar` };
  }

  // ═══════════════════════════════════════════════════════════════
  // VALOR ENDEREÇÁVEL = faturamento × EBITDA × WTP do tier
  // Sem split mídia/tech/serviço — cliente V1/V2 não segue 55/20/25
  // ═══════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════
  // NOMES QUE TIPICAMENTE SÃO AGÊNCIA
  // ═══════════════════════════════════════════════════════════════
  const PADROES_AGENCIA = [
    { re: /\bag[eê]ncia\b/i, tipo: 'agência' },
    { re: /\bpublicidade\b|\bpublicit[áa]ri/i, tipo: 'publicidade' },
    { re: /\bpropaganda\b/i, tipo: 'propaganda' },
    { re: /\bmarketing\b/i, tipo: 'marketing' },
    { re: /\bassessoria\s+de\s+(marketing|imprensa|comunica)/i, tipo: 'assessoria de mkt' },
    { re: /\bconsultoria\s+(de\s+marketing|em\s+marketing|digital)\b/i, tipo: 'consultoria digital' },
    { re: /\bstudio\s+(criativo|digital|estrat[eé]gic)/i, tipo: 'studio criativo' },
    { re: /\b(criativo|digital)\s+studio\b/i, tipo: 'studio criativo' },
    { re: /\b(lab|hub|house)\s+(criativo|digital|de\s+conte[úu]do)\b/i, tipo: 'lab/hub criativo' },
    { re: /\bgrowth\b/i, tipo: 'growth' },
    { re: /\bbranding\b/i, tipo: 'branding' },
    { re: /\btr[áa]fego\s+pago\b/i, tipo: 'tráfego pago' },
    { re: /\bsocial\s*media\b/i, tipo: 'social media' },
    { re: /\bcomunica[çc][ãa]o\b/i, tipo: 'comunicação' },
    { re: /\bm[íi]dia\b/i, tipo: 'mídia' },
    { re: /\bperformance\b/i, tipo: 'performance' },
    { re: /\binbound\b/i, tipo: 'inbound' },
  ];

  function detectarNomeAgencia(nomeEmpresa) {
    if (!nomeEmpresa) return null;
    for (const p of PADROES_AGENCIA) {
      if (p.re.test(nomeEmpresa)) return { tipo: p.tipo, nome: nomeEmpresa };
    }
    return null;
  }

  function fmtBRL(v) {
    if (v == null) return '?';
    return 'R$ ' + Math.round(v).toLocaleString('pt-BR');
  }

  function fmtK(v) {
    if (v == null) return '?';
    if (v >= 1000000) return (v / 1000000).toFixed(1).replace('.0', '') + 'M';
    if (v >= 1000) return Math.round(v / 1000) + 'k';
    return String(Math.round(v));
  }

  // ═══════════════════════════════════════════════════════════════
  // DECISOR POR TIER — alçada desce conforme a empresa cresce
  // ═══════════════════════════════════════════════════════════════
  // v9.6: rede de segurança. Mesmo com a regra no prompt, o modelo pode usar
  // avaliação/comentário como "prova" de cargo. Caso real: "o nome aparece em uma
  // avaliação do restaurante" virou decisor_papel = "Sócio".
  const EVIDENCIA_INVALIDA = [
    { re: /avalia[çc][ãa]o|avalia[çc][õo]es|review|coment[áa]ri|resenha/i, o: 'avaliação/comentário' },
    { re: /curtid|marca[çc][ãa]o em foto|tag(ueado|ado)? em/i, o: 'interação em rede social' },
    { re: /depoiment|testemunh/i, o: 'depoimento de cliente' },
    { re: /scribd|uploader|enviou (o |um )?documento|upload de (arquivo|documento)|slideshare|academia\.edu/i, o: 'upload de documento' },
    { re: /lista de contatos|planilha de|cadastro p[úu]blico de/i, o: 'menção em lista/planilha' },
    { re: /tripadvisor|ifood|google\s*(my\s*)?business|reclame\s*aqui/i, o: 'plataforma de avaliação' },
  ];

  const FONTE_VALIDA = ['qsa', 'linkedin_contato', 'linkedin_empresa', 'site_empresa', 'noticia', 'registro_classe'];

  // v9.9: rede de segurança contra a contradição "não sei qual é a empresa,
  // mas afirmo que ela é concorrente". Caso real: lead "Pinheiro" — a IA listou
  // "Pinheiro Company Marketing" como homônimo que NÃO é o lead e usou a mesma
  // empresa como prova de concorrência.
  // v9.10: a IA marca empresa_existe="sim" mas o próprio texto admite que não sabe
  // QUAL empresa é. Caso real: "R&F" com 9 homônimos e "não é possível determinar
  // qual delas é a correta" — marcado como ✅.
  const AMBIGUIDADE = [
    /n[ãa]o (?:foi |é )?poss[íi]vel determinar qual/i,
    /n[ãa]o (?:d[áa]|deu) para (?:saber|determinar) qual/i,
    /qual delas (?:é|seria)/i,
    /m[úu]ltiplas empresas/i,
    /diversas empresas/i,
    /v[áa]rias empresas/i,
    /sem mais informa[çc][õo]es/i,
    /dif[íi]cil determinar qual/i,
    /n[ãa]o (?:foi |é )?poss[íi]vel identificar (?:a|qual)/i,
    /impede a identifica[çc][ãa]o/i,
  ];

  // v9.28: STOP por "empresa não existe" é o veredito mais caro do sistema.
  // Só vale se a busca esgotou as rotas — em especial os handles de rede social,
  // porque muito negócio pequeno brasileiro só existe no Instagram.
  // Caso real: "LM PRIME VISUAL" marcado STOP em 2.6s, com Instagram ativo.
  function buscaEsgotada(m) {
    if (!m) return { esgotada: false, faltou: 'sem dados' };
    const q = (m.buscas_feitas || []).join(' ').toLowerCase();
    const txt = `${q} ${String(m.empresa_evidencia || '')} ${String(m.resumo || '')}`.toLowerCase();

    const tentouInsta = /instagram|@[a-z0-9._]{3,}|handle/.test(txt);
    const tentouFace = /facebook|fb\.com/.test(txt);
    const tentouCidade = /maps|cidade|endere[çc]o|rua |avenida/.test(txt);

    const faltando = [];
    if (!tentouInsta) faltando.push('Instagram (handle sem espaço)');
    if (!tentouFace) faltando.push('Facebook');
    if (!tentouCidade) faltando.push('Maps/cidade');

    // Instagram é o que mais importa: sem ele, a busca não está esgotada
    return { esgotada: tentouInsta, faltou: faltando.join(' · ') };
  }

  function checarEmpresaIdentificada(m) {
    if (!m || m.empresa_existe !== 'sim') return null;

    const txt = `${m.empresa_evidencia || ''} ${m.resumo || ''}`;
    const admite = AMBIGUIDADE.find(re => re.test(txt));
    if (admite) {
      return {
        rebaixar: true,
        motivo: 'a própria investigação admite que não sabe qual empresa é o lead',
      };
    }

    // muitos homônimos e nenhuma âncora concreta desta empresa
    const homs = (m.homonimos_encontrados || []).length;
    const semAncora = !m.site && !m.instagram && !m.endereco && !m.cnpj_descoberto;
    if (homs >= 3 && semAncora) {
      return {
        rebaixar: true,
        motivo: `${homs} homônimos encontrados e nenhuma âncora concreta (site, Instagram, endereço ou CNPJ) desta empresa`,
      };
    }
    return null;
  }

  function checarConcorrenteSemIdentificacao(m) {
    if (!m || m.is_concorrente === null || m.is_concorrente === undefined) return null;

    // empresa ambígua conta como não identificada, mesmo marcada "sim"
    const amb = checarEmpresaIdentificada(m);
    const naoIdentificada = m.empresa_existe === 'nao' || m.empresa_existe === 'parcial' || !!amb;

    // afirmar "não é concorrente" sem saber qual empresa também é infundado,
    // embora o erro seja mais barato que o falso positivo
    if (naoIdentificada && m.is_concorrente === false) {
      return {
        invalido: true,
        direcao: 'negativa',
        motivo: 'sem identificar qual empresa é o lead, não dá pra afirmar que NÃO é agência — '
              + 'a conclusão vale para alguma empresa encontrada, não necessariamente para esta.',
      };
    }
    if (m.is_concorrente !== true) return null;

    // 1) empresa não identificada → não há o que classificar
    if (naoIdentificada) {
      return {
        invalido: true,
        direcao: 'positiva',
        motivo: (amb ? amb.motivo : `a empresa não foi identificada (empresa_existe = "${m.empresa_existe}")`)
              + ' — então não há como afirmar que ELA é agência. Achar que existem agências '
              + 'com nome parecido não identifica o lead.',
      };
    }

    // 2) a prova de concorrência cita justamente os homônimos descartados
    const homs = (m.homonimos_encontrados || []).map(h => normalizarTexto(h)).filter(h => h.length > 4);
    const ev = normalizarTexto(m.concorrente_evidencia || '');
    if (homs.length && ev) {
      const usados = homs.filter(h => {
        const nucleo = h.split(/[^a-z0-9]+/).filter(w => w.length > 3).slice(0, 3).join(' ');
        return nucleo && ev.includes(nucleo);
      });
      if (usados.length) {
        return {
          invalido: true,
          motivo: 'a prova de concorrência cita empresa(s) que a própria investigação '
                + 'listou como homônimas que NÃO são o lead — contradição.',
        };
      }
    }
    return null;
  }

  function checarEvidenciaDecisor(m) {
    if (!m) return null;
    const ev = String(m.decisor_evidencia || '');
    if (!ev) return null;

    const achado = EVIDENCIA_INVALIDA.find(x => x.re.test(ev));
    if (!achado) return null;

    // se a fonte declarada é válida, a menção pode ser secundária — não invalida
    if (m.decisor_fonte && FONTE_VALIDA.includes(m.decisor_fonte)) return null;

    return {
      invalida: true,
      tipo: achado.o,
      texto: `a evidência de cargo veio de ${achado.o} — isso não prova vínculo. `
           + 'Quem avalia um negócio é cliente, não dono.',
    };
  }

  function validarDecisorPorTier(papel, tier) {
    if (!papel) return { ok: null, nota: '' };
    const p = String(papel).toLowerCase();

    const isSocio = /s[óo]cio|dono|fundador|propriet|ceo|titular/.test(p);
    const isDiretor = /diretor|c-?level|cfo|cmo|coo|presidente/.test(p);
    const isGerente = /gerente|head|coordenador|supervisor/.test(p);

    const tierPequeno = ['TINY', 'SMALL'].includes(tier);
    const tierMedio = tier === 'MEDIUM';
    const tierGrande = ['MEDIUM-PLUS', 'LARGE', 'LARGE-PLUS', 'ENTERPRISE'].includes(tier);

    if (isSocio) return { ok: true, nota: 'sócio/dono — alçada máxima em qualquer porte' };

    if (tierPequeno) {
      if (isDiretor) return { ok: false, nota: `"${papel}" em empresa até R$ 399k — título provavelmente inflado. Confirmar se é o dono` };
      if (isGerente) return { ok: false, nota: `"${papel}" sem alçada nesse porte — vai precisar levar pro dono` };
      return { ok: false, nota: 'nesse porte só sócio/dono decide' };
    }
    if (tierMedio) {
      if (isDiretor) return { ok: true, nota: 'diretor em MEDIUM — alçada provável' };
      if (isGerente) return { ok: false, nota: 'gerente em MEDIUM — alçada improvável' };
    }
    if (tierGrande) {
      if (isDiretor) return { ok: true, nota: 'diretor em empresa grande — alçada real' };
      if (isGerente) return { ok: true, nota: 'gerente/head em empresa grande — pode ter orçamento próprio' };
    }
    return { ok: null, nota: '' };
  }

  // ═══════════════════════════════════════════════════════════════
  // ESTILOS
  // ═══════════════════════════════════════════════════════════════
  GM_addStyle(`
    #v4-fab {
      position: fixed !important; bottom: 28px !important; right: 28px !important;
      display: flex !important; align-items: center; gap: 10px;
      background: #CC1414 !important; color: #fff !important;
      padding: 14px 22px; border-radius: 12px;
      cursor: pointer; font-family: system-ui, -apple-system, sans-serif;
      font-size: 13px; font-weight: 700;
      z-index: 2147483647 !important; border: none;
      box-shadow: 0 4px 24px rgba(204,20,20,0.45);
      transition: all 0.2s ease; user-select: none;
    }
    #v4-fab:hover { background: #E02020 !important; transform: translateY(-2px); }
    @keyframes v4-spin { to { transform: rotate(360deg); } }
    @keyframes v4-pulse-red {
      0%,100% { box-shadow: 0 0 0 0 rgba(204,20,20,0.6); }
      50% { box-shadow: 0 0 0 6px rgba(204,20,20,0); }
    }

    #v4-overlay {
      display: none; position: fixed !important; inset: 0;
      background: rgba(0,0,0,0.88); z-index: 2147483646 !important;
      backdrop-filter: blur(8px);
    }
    #v4-overlay.active { display: block; }

    /* ═══ MODO FLUTUANTE (v9.12) — lado a lado com o LeadBroker ═══ */
    #v4-overlay.flutuante {
      background: none !important; backdrop-filter: none !important;
      pointer-events: none;   /* a página atrás continua clicável */
    }
    #v4-overlay.flutuante #v4-panel {
      pointer-events: auto;
      top: 16px; right: 16px; left: auto; bottom: auto;
      transform: none;
      width: 560px; height: calc(100vh - 32px);
      max-height: calc(100vh - 32px); max-width: 92vw;
      border-color: #333;
      box-shadow: 0 20px 60px rgba(0,0,0,.75), 0 0 0 1px rgba(255,255,255,.05);
      resize: none;
    }
    #v4-overlay.flutuante #v4-header {
      cursor: grab; user-select: none;
    }
    #v4-overlay.flutuante #v4-header:active { cursor: grabbing; }
    #v4-overlay.flutuante.arrastando #v4-panel { transition: none; opacity: .92; }

    /* alça de redimensionamento no canto inferior esquerdo */
    /* alça do rodapé: canto superior direito, porque o inferior esquerdo é a âncora */
    #v4-resize-tr {
      display: none; position: absolute; top: 0; right: 0;
      width: 20px; height: 20px; cursor: nesw-resize;
      background: linear-gradient(225deg, transparent 45%, #444 45%, #444 55%, transparent 55%);
      border-top-right-radius: 16px; z-index: 3;
    }
    #v4-overlay.rodape #v4-resize-tr { display: block; }
    #v4-resize-tr:hover { background: linear-gradient(225deg, transparent 45%, #888 45%, #888 55%, transparent 55%); }
    #v4-overlay.rodape #v4-resize { display: none; }

    #v4-resize {
      display: none; position: absolute; bottom: 0; left: 0;
      width: 18px; height: 18px; cursor: nesw-resize;
      background: linear-gradient(45deg, transparent 45%, #444 45%, #444 55%, transparent 55%);
      border-bottom-left-radius: 16px;
    }
    #v4-overlay.flutuante #v4-resize { display: block; }
    #v4-resize:hover { background: linear-gradient(45deg, transparent 45%, #888 45%, #888 55%, transparent 55%); }

    /* ═══ MODO RECOLHIDO (v9.13) — faixa lateral só com os faróis ═══ */
    #v4-overlay.recolhido #v4-panel {
      width: 216px !important; min-width: 216px;
    }
    #v4-overlay.recolhido #v4-add-bar,
    #v4-overlay.recolhido #v4-health,
    #v4-overlay.recolhido #v4-footer,
    #v4-overlay.recolhido .v4-checks,
    #v4-overlay.recolhido .v4-tags,
    #v4-overlay.recolhido .v4-fitwrap,
    #v4-overlay.recolhido .v4-flagswrap,
    #v4-overlay.recolhido .v4-m2wrap,
    #v4-overlay.recolhido .v4-m3wrap,
    #v4-overlay.recolhido .v4-actions,
    #v4-overlay.recolhido .v4-sec,
    #v4-overlay.recolhido .v4-flags,
    #v4-overlay.recolhido .v4-de-hist,
    #v4-overlay.recolhido .v4-mesmo-lead,
    #v4-overlay.recolhido #v4-empty-sub { display: none !important; }
    #v4-overlay.recolhido .v4-brand-name { font-size: 9px; letter-spacing: 1px; }
    #v4-overlay.recolhido .v4-card-head { padding: 9px 10px; gap: 8px; flex-direction: column; align-items: stretch; }
    #v4-overlay.recolhido .v4-card-num { align-self: flex-start; }
    #v4-overlay.recolhido .v4-card-title { font-size: 12px; }
    #v4-overlay.recolhido .v4-card-meta { font-size: 10px; }
    #v4-overlay.recolhido .v4-card-verdict { align-self: stretch; min-width: 0; }
    #v4-overlay.recolhido .v4-farol { width: 100%; padding: 7px 4px 6px; }
    #v4-overlay.recolhido .v4-farol-luz { font-size: 20px; }
    #v4-overlay.recolhido .v4-card { cursor: pointer; }
    #v4-overlay.recolhido .v4-card:hover { border-color: #555; }
    #v4-overlay.recolhido #v4-body { padding: 8px 10px; }

    /* ═══ FAIXA INFERIOR (v9.14) — preserva a largura toda da grade de cards ═══ */
    #v4-overlay.inferior #v4-panel {
      left: 12px; right: 12px; bottom: 12px; top: auto;
      width: auto !important; height: 176px !important;
      max-height: 176px; transform: none;
      flex-direction: column;
    }
    #v4-overlay.inferior #v4-add-bar,
    #v4-overlay.inferior #v4-health,
    #v4-overlay.inferior #v4-footer,
    #v4-overlay.inferior .v4-checks,
    #v4-overlay.inferior .v4-tags,
    #v4-overlay.inferior .v4-fitwrap,
    #v4-overlay.inferior .v4-flagswrap,
    #v4-overlay.inferior .v4-m2wrap,
    #v4-overlay.inferior .v4-m3wrap,
    #v4-overlay.inferior .v4-actions,
    #v4-overlay.inferior .v4-sec,
    #v4-overlay.inferior .v4-flags,
    #v4-overlay.inferior .v4-de-hist,
    #v4-overlay.inferior .v4-mesmo-lead,
    #v4-overlay.inferior #v4-empty-sub,
    #v4-overlay.inferior #v4-empty-icon { display: none !important; }
    #v4-overlay.inferior #v4-body {
      display: flex; flex-direction: row; align-items: stretch; gap: 8px;
      overflow-x: auto; overflow-y: hidden; padding: 10px 12px;
    }
    #v4-overlay.inferior #v4-body::-webkit-scrollbar { height: 6px; }
    #v4-overlay.inferior .v4-card {
      min-width: 184px; max-width: 184px; margin: 0; flex-shrink: 0;
      cursor: pointer; display: flex; flex-direction: column;
    }
    #v4-overlay.inferior .v4-card:hover { border-color: #555; }
    #v4-overlay.inferior .v4-card-head {
      padding: 8px 10px; gap: 6px; flex-direction: column;
      align-items: stretch; height: 100%;
    }
    #v4-overlay.inferior .v4-card-num { align-self: flex-start; }
    #v4-overlay.inferior .v4-card-title { font-size: 11px; white-space: normal; line-height: 1.3; }
    #v4-overlay.inferior .v4-card-meta { font-size: 9px; }
    #v4-overlay.inferior .v4-card-verdict { align-self: stretch; min-width: 0; margin-top: auto; }
    #v4-overlay.inferior .v4-farol { width: 100%; padding: 5px 4px 4px; }
    #v4-overlay.inferior .v4-farol-luz { font-size: 17px; margin-bottom: 2px; }
    #v4-overlay.inferior .v4-farol-txt { font-size: 9px; }
    #v4-overlay.inferior .v4-farol-sub { display: none; }
    #v4-overlay.inferior #v4-empty { padding: 20px; }
    #v4-overlay.inferior #v4-resize { display: none; }

    /* ═══ VOLTAR À FAIXA (v9.15) ═══ */
    #v4-voltar {
      display: none; align-items: center; gap: 6px;
      padding: 7px 12px; border-radius: 7px;
      border: 1px solid #3B82F650; background: rgba(59,130,246,.12);
      color: #93C5FD; font-size: 11px; font-weight: 700;
      cursor: pointer; font-family: inherit; white-space: nowrap;
    }
    #v4-voltar:hover { border-color: #3B82F6; background: rgba(59,130,246,.22); }
    #v4-overlay.veio-da-faixa #v4-voltar { display: flex; }

    /* nos modos de faixa, marca quem precisa de leitura */
    #v4-overlay.recolhido .v4-card.amarelo .v4-card-title::after,
    #v4-overlay.inferior .v4-card.amarelo .v4-card-title::after {
      content: 'ler'; margin-left: 6px; padding: 1px 5px; border-radius: 3px;
      background: rgba(217,119,6,.3); color: #FBBF24;
      font-size: 8px; font-weight: 900; letter-spacing: .5px; text-transform: uppercase;
      flex-shrink: 0;
    }
    /* verde não precisa de nada — some o "clique para ver" */
    #v4-overlay.recolhido .v4-card.verde,
    #v4-overlay.inferior .v4-card.verde { opacity: .92; }
    #v4-overlay.recolhido .v4-card.verde:hover,
    #v4-overlay.inferior .v4-card.verde:hover { opacity: 1; }
    /* vermelho fica discreto — passa direto na maioria dos casos */
    #v4-overlay.recolhido .v4-card.vermelho:not(.concorrente),
    #v4-overlay.inferior .v4-card.vermelho:not(.concorrente) { opacity: .6; }
    #v4-overlay.recolhido .v4-card.vermelho:hover,
    #v4-overlay.inferior .v4-card.vermelho:hover { opacity: 1; }

    #v4-layout-btn {
      background: none; border: 1px solid #2A2A2A; color: #666;
      width: 28px; height: 28px; border-radius: 6px; cursor: pointer;
      font-size: 13px; display: flex; align-items: center; justify-content: center;
      margin-right: 6px;
    }
    #v4-layout-btn:hover { border-color: #444; color: #999; }


    #v4-panel {
      position: absolute; top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      background: #0E0E0E; border: 1px solid #222;
      border-radius: 16px; width: 760px;
      max-width: 96vw; max-height: 92vh;
      overflow: hidden; display: flex; flex-direction: column;
      font-family: system-ui, -apple-system, sans-serif;
      box-shadow: 0 40px 100px rgba(0,0,0,0.9);
    }

    #v4-header {
      padding: 14px 22px; border-bottom: 1px solid #1E1E1E;
      display: flex; align-items: center; justify-content: space-between;
      flex-shrink: 0;
    }
    .v4-brand { display: flex; align-items: center; gap: 10px; }
    .v4-dot { width: 8px; height: 8px; border-radius: 50%; background: #CC1414; box-shadow: 0 0 8px rgba(204,20,20,0.6); }
    .v4-brand-name { font-size: 11px; font-weight: 700; color: #555; letter-spacing: 2.5px; text-transform: uppercase; }
    .v4-queue-count {
      background: rgba(204,20,20,0.15); color: #E02020;
      font-size: 10px; font-weight: 700; padding: 3px 8px;
      border-radius: 4px; letter-spacing: 0.5px;
    }
    #v4-close {
      background: none; border: 1px solid #2A2A2A; color: #666;
      width: 28px; height: 28px; border-radius: 6px;
      cursor: pointer; font-size: 13px;
      display: flex; align-items: center; justify-content: center;
    }
    #v4-close:hover { border-color: #444; color: #999; }

    #v4-add-bar {
      padding: 12px 22px; border-bottom: 1px solid #1A1A1A;
      background: #0A0A0A; display: flex; gap: 8px; align-items: center;
    }
    #v4-add-btn {
      flex: 1; padding: 12px; border-radius: 8px;
      border: 1px dashed #2A2A2A; background: rgba(204,20,20,0.05);
      color: #CC1414; font-size: 12px; font-weight: 700;
      cursor: pointer; font-family: inherit;
      letter-spacing: 0.5px; transition: all 0.15s;
    }
    #v4-add-btn:hover { border-color: #CC1414; background: rgba(204,20,20,0.12); }
    #v4-clear-queue {
      padding: 12px 14px; border-radius: 8px;
      border: 1px solid #2A2A2A; background: none;
      color: #666; font-size: 11px; cursor: pointer;
      font-family: inherit; white-space: nowrap;
    }
    #v4-clear-queue:hover { border-color: #444; color: #999; }

    #v4-body { flex: 1; display: flex; overflow: hidden; min-height: 0; }
    #v4-cards { flex: 1; overflow-y: auto; padding: 12px 16px; min-width: 0; }
    #v4-cards::-webkit-scrollbar { width: 6px; }
    #v4-cards::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }

    /* ═══ SPLIT HORIZONTAL NO RODAPÉ (v9.19) ═══
       Painel largo e baixo, encostado no rodapé: a grade de cards do LeadBroker
       fica visível inteira em cima, e o painel usa a largura toda. */
    #v4-overlay.rodape #v4-panel {
      left: 12px; right: auto; bottom: 12px; top: auto;
      transform: none;
      /* 62% por padrão: deixa livre a coluna de detalhe do lead, à direita */
      width: var(--v4-rodape-w, 62vw) !important;
      min-width: 460px; max-width: calc(100vw - 24px);
      /* 1/5 da tela por padrão — dá pra ver a grade de cards inteira em cima.
         A variável é ajustada pelo botão de altura. */
      height: var(--v4-rodape-h, 20vh) !important;
      min-height: 150px; max-height: 55vh;
    }
    /* na altura mínima, o cabeçalho e a barra de colar comem o espaço útil */
    #v4-overlay.rodape.baixo #v4-add-bar,
    #v4-overlay.rodape.baixo #v4-health { display: none; }
    #v4-overlay.rodape.baixo .v4-prod-topo { margin-bottom: 7px; }
    #v4-overlay.rodape.baixo .v4-prod-kpi { padding: 5px 8px; }
    #v4-overlay.rodape.baixo .v4-prod-kpi b { font-size: 15px; }
    #v4-overlay.rodape.baixo .v4-prod-sec { margin: 8px 0 4px; }
    #v4-overlay.rodape.baixo .v4-prod-linha { padding: 6px 10px; margin-bottom: 3px; }

    #v4-altura {
      background: none; border: 1px solid #2A2A2A; color: #666;
      height: 28px; padding: 0 8px; border-radius: 6px; cursor: pointer;
      font-size: 10px; font-weight: 700; display: none;
      align-items: center; justify-content: center; white-space: nowrap;
    }
    #v4-altura:hover { border-color: #444; color: #999; }
    #v4-overlay.rodape #v4-altura { display: flex; }
    #v4-overlay.rodape #v4-rail { display: block; width: 176px; }
    #v4-overlay.rodape #v4-add-bar { padding: 8px 16px; }
    #v4-overlay.rodape #v4-add-btn { padding: 8px; font-size: 11px; }
    #v4-overlay.rodape #v4-health { padding: 6px 16px; }
    #v4-overlay.rodape .v4-prod-topo { margin-bottom: 10px; }
    #v4-overlay.rodape .v4-prod-kpi { padding: 7px 10px; }
    #v4-overlay.rodape .v4-prod-kpi b { font-size: 18px; }
    #v4-overlay.rodape .v4-card { display: none; }
    #v4-overlay.rodape .v4-card.sel { display: block; }
    #v4-overlay.rodape #v4-producao { display: none; }
    #v4-overlay.rodape #v4-producao.on { display: block; }

    /* ═══ PRODUÇÃO (v9.18) — tela base do lado direito ═══ */
    #v4-producao { display: none; padding: 4px 2px; }
    #v4-overlay.split #v4-producao.on { display: block; }
    .v4-prod-topo {
      display: flex; gap: 8px; margin-bottom: 14px;
    }
    .v4-prod-kpi {
      flex: 1; padding: 10px 12px; border-radius: 9px;
      background: rgba(255,255,255,.03); border: 1px solid #1F1F1F;
      text-align: center;
    }
    .v4-prod-kpi b { display: block; font-size: 22px; font-weight: 900; line-height: 1.1; }
    .v4-prod-kpi span {
      font-size: 9px; letter-spacing: 1px; text-transform: uppercase;
      color: #666; display: block; margin-top: 3px;
    }
    .v4-prod-kpi.go b { color: #4ADE80; }
    .v4-prod-kpi.caution b { color: #FBBF24; }
    .v4-prod-kpi.stop b { color: #FCA5A5; }
    .v4-prod-kpi.run b { color: #93C5FD; }

    .v4-prod-sec {
      font-size: 9px; font-weight: 700; letter-spacing: 1.5px;
      color: #555; text-transform: uppercase; margin: 14px 0 7px;
    }
    .v4-prod-linha {
      display: flex; align-items: center; gap: 10px;
      padding: 9px 11px; margin-bottom: 5px; border-radius: 7px;
      background: #131313; border: 1px solid #1F1F1F;
      cursor: pointer; border-left-width: 3px;
    }
    .v4-prod-linha:hover { border-color: #3A3A3A; background: #171717; }
    .v4-prod-linha.verde { border-left-color: #16A34A; }
    .v4-prod-linha.amarelo { border-left-color: #D97706; }
    .v4-prod-linha.vermelho { border-left-color: #CC1414; }
    .v4-prod-linha.processing { border-left-color: #3B82F6; }
    .v4-prod-linha.pending { border-left-color: #444; opacity: .7; }
    .v4-prod-luz { font-size: 16px; flex-shrink: 0; width: 20px; text-align: center; }
    .v4-prod-nome {
      flex: 1; min-width: 0; font-size: 12px; font-weight: 700; color: #E4E4E4;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .v4-prod-meta { font-size: 10px; color: #777; white-space: nowrap; }
    .v4-prod-est {
      font-size: 9px; font-weight: 800; letter-spacing: .5px;
      text-transform: uppercase; white-space: nowrap; min-width: 58px; text-align: right;
    }
    .v4-prod-linha.verde .v4-prod-est { color: #4ADE80; }
    .v4-prod-linha.amarelo .v4-prod-est { color: #FBBF24; }
    .v4-prod-linha.vermelho .v4-prod-est { color: #FCA5A5; }
    .v4-prod-linha.processing .v4-prod-est { color: #93C5FD; }
    .v4-prod-linha.pending .v4-prod-est { color: #666; }
    .v4-prod-vazio { padding: 40px 20px; text-align: center; color: #555; font-size: 12px; line-height: 1.6; }

    .v4-rail-item.prod {
      background: rgba(59,130,246,.10); border-left: 3px solid #3B82F6;
      margin-bottom: 9px;
    }
    .v4-rail-item.prod.sel { background: rgba(59,130,246,.22); border-color: #3B82F6; }
    .v4-rail-item.prod .v4-rail-est { color: #93C5FD; }

    /* ═══ TRILHA DE FARÓIS (v9.17) ═══
       Lista fixa à esquerda com o farol de cada lead. Clicar abre o detalhe
       à direita, sem trocar de layout nem perder a lista de vista. */
    #v4-rail {
      width: 158px; flex-shrink: 0; overflow-y: auto;
      border-right: 1px solid #1E1E1E; background: #0A0A0A;
      padding: 10px 8px; display: none;
    }
    #v4-rail::-webkit-scrollbar { width: 5px; }
    #v4-rail::-webkit-scrollbar-thumb { background: #2A2A2A; border-radius: 3px; }
    #v4-overlay.split #v4-rail { display: block; }

    .v4-rail-lbl {
      font-size: 8px; font-weight: 700; letter-spacing: 1.5px;
      color: #444; text-transform: uppercase; padding: 0 4px 7px;
    }
    .v4-rail-item {
      display: flex; align-items: center; gap: 8px;
      padding: 7px 8px; margin-bottom: 4px; border-radius: 7px;
      cursor: pointer; border: 1px solid transparent;
      transition: background .12s, border-color .12s;
    }
    .v4-rail-item:hover { background: rgba(255,255,255,.045); }
    .v4-rail-item.sel { background: rgba(255,255,255,.075); border-color: #3A3A3A; }
    .v4-rail-luz { font-size: 15px; line-height: 1; flex-shrink: 0; }
    .v4-rail-txt { min-width: 0; flex: 1; }
    .v4-rail-nome {
      font-size: 10px; font-weight: 700; color: #DDD; line-height: 1.25;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .v4-rail-est {
      font-size: 8px; font-weight: 800; letter-spacing: .4px;
      text-transform: uppercase; margin-top: 2px;
    }
    .v4-rail-item.verde .v4-rail-est { color: #4ADE80; }
    .v4-rail-item.amarelo .v4-rail-est { color: #FBBF24; }
    .v4-rail-item.vermelho .v4-rail-est { color: #FCA5A5; }
    .v4-rail-item.processing .v4-rail-est { color: #777; }
    .v4-rail-item.verde { border-left: 3px solid #16A34A; }
    .v4-rail-item.amarelo { border-left: 3px solid #D97706; }
    .v4-rail-item.vermelho { border-left: 3px solid #CC1414; }
    .v4-rail-item.processing { border-left: 3px solid #444; }
    .v4-rail-item.concorrente { background: rgba(204,20,20,.14); }

    /* no split, mostra só o card selecionado */
    #v4-overlay.split .v4-card { display: none; }
    #v4-overlay.split .v4-card.sel { display: block; }
    #v4-overlay.split #v4-panel { width: 720px; }

    #v4-footer {
      padding: 10px 22px; border-top: 1px solid #1A1A1A;
      display: flex; gap: 8px; flex-shrink: 0; background: #0A0A0A;
    }
    .v4-btn-sec {
      padding: 8px 14px; border-radius: 7px;
      border: 1px solid #2A2A2A; background: none;
      color: #666; font-size: 10px; cursor: pointer;
      font-family: inherit; transition: all 0.15s;
      letter-spacing: 0.3px;
    }
    .v4-btn-sec:hover { border-color: #444; color: #999; background: #141414; }

    #v4-empty { padding: 60px 24px; text-align: center; color: #444; }
    #v4-empty-icon { font-size: 40px; margin-bottom: 12px; opacity: 0.5; }
    #v4-empty-title { font-size: 14px; font-weight: 700; color: #666; margin-bottom: 6px; }
    #v4-empty-sub { font-size: 12px; line-height: 1.6; }

    /* ═══ CARD ═══ */
    .v4-card {
      background: #131313; border: 1px solid #1F1F1F;
      border-radius: 10px; margin-bottom: 10px;
      overflow: hidden; transition: border-color 0.2s;
    }
    .v4-card.verde { border-left: 3px solid #16A34A; }
    .v4-card.amarelo { border-left: 3px solid #D97706; }
    .v4-card.vermelho { border-left: 3px solid #CC1414; }
    .v4-card.processing { border-left: 3px solid #666; }
    .v4-card.error { border-left: 3px solid #7F1D1D; }
    .v4-card.concorrente {
      border-left: 4px solid #CC1414 !important;
      background: linear-gradient(90deg, rgba(204,20,20,0.08) 0%, #131313 40%);
    }

    .v4-card-head {
      padding: 14px 16px 12px;
      display: flex; align-items: flex-start; gap: 12px;
    }
    .v4-card-num {
      font-size: 10px; color: #666; font-weight: 700;
      background: #1A1A1A; padding: 3px 7px; border-radius: 4px;
      min-width: 26px; text-align: center; flex-shrink: 0;
    }
    .v4-card.concorrente .v4-card-num { background: #CC1414; color: #fff; }
    .v4-card-titlewrap { flex: 1; min-width: 0; }
    .v4-card-title {
      font-size: 15px; font-weight: 800; color: #F0F0F0;
      margin-bottom: 4px; display: flex; align-items: center; gap: 8px;
      flex-wrap: wrap;
    }
    .v4-card-meta { font-size: 11px; color: #888; }
    .v4-card-verdict {
      display: flex; flex-direction: column; align-items: center;
      gap: 4px; flex-shrink: 0; min-width: 92px;
    }
    .v4-verdict-time { font-size: 10px; color: #555; font-variant-numeric: tabular-nums; }

    /* ═══ BOXES (v11.0) ═══ */
    /* v12.0: tudo isso repetia o que os 4 boxes e os dados já dizem.
       O card virou: farol → 4 boxes → dados encontrados → ações. */
    /* v12.1: o span do grupo técnico usava display:none inline, mas o flex do
       footer sobrescrevia e todos os botões apareciam de uma vez. */
    #v4-tec { display: contents; }
    #v4-tec.v4-tec-oculto { display: none; }

    /* v14.11: cor base do painel. NÃO usar "#v4-overlay *" aqui — a
       especificidade de ID sobrescreveria as cores dos boxes (verde, amarelo,
       vermelho) e tudo ficaria cinza. */
    #v4-overlay { color: #E8E8E8; }

    /* v14.11: .v4-flagswrap é o container antigo (escondido); .v4-flags é a
       LISTA usada pelo bloco do momento 2 e precisa aparecer. Eram nomes
       parecidos demais e o CSS escondia o bloco novo junto com o velho. */
    .v4-checks, .v4-tags, .v4-fitwrap, .v4-flagswrap,
    .v4-coerencia, .v4-contra-fat, .v4-oficial { display: none !important; }
    .v4-sec .v4-flags { display: block !important; }
    .v4-boxes { display: grid; grid-template-columns: repeat(auto-fit, minmax(146px, 1fr)); gap: 7px; padding: 0 16px 12px; }
    .v4-box { border-radius: 8px; padding: 9px 11px; }
    /* v17.0: destaque do porte subdeclarado — o achado que encontra lead barato */
    .v4-portemaior {
      margin: 0 16px 10px; padding: 9px 12px; border-radius: 7px;
      background: linear-gradient(135deg, rgba(59,130,246,.14), rgba(59,130,246,.06));
      border: 1px solid rgba(59,130,246,.35);
    }
    .v4-pm-tit { font-size: 10px; font-weight: 800; letter-spacing: .8px; color: #93C5FD; }
    .v4-pm-sinais { font-size: 11.5px; color: #E8E8E8; margin-top: 4px; line-height: 1.45; }
    .v4-pm-nota { font-size: 10.5px; color: #8A8A8A; margin-top: 3px; }

    .v4-box-lbl { font-size: 10px; font-weight: 800; letter-spacing: .8px; text-transform: uppercase; }
    .v4-box-txt { font-size: 12px; line-height: 1.35; margin-top: 4px; color: #E8E8E8; }
    .v4-box-sub { font-size: 10px; line-height: 1.4; color: #999; margin-top: 2px; }
    /* v12.0: o rótulo estava quase invisível (verde escuro sobre verde escuro).
       Agora o rótulo é claro e o texto é branco — leitura em 1 segundo. */
    .v4-box.verde     { background: rgba(22,163,74,.16); border: 1px solid rgba(22,163,74,.3); }
    .v4-box.verde .v4-box-lbl     { color: #4ADE80; }
    .v4-box.amarelo   { background: rgba(217,119,6,.16); border: 1px solid rgba(217,119,6,.32); }
    .v4-box.amarelo .v4-box-lbl   { color: #FBBF24; }
    .v4-box.vermelho  { background: rgba(204,20,20,.16); border: 1px solid rgba(204,20,20,.34); }
    .v4-box.vermelho .v4-box-lbl  { color: #F87171; }
    .v4-box.concorrente { background: rgba(204,20,20,.34); border: 1px solid rgba(204,20,20,.6); }
    .v4-box.concorrente .v4-box-lbl { color: #FCA5A5; }
    .v4-box .v4-box-txt { color: #E8E8E8; font-weight: 600; }
    .v4-box .v4-box-sub { color: #8A8A8A; }
    .v4-dados { padding: 11px 16px 0; margin: 0 16px 12px; border-top: 1px solid #1E1E1E; }
    .v4-dados-lbl { font-size: 9px; font-weight: 700; letter-spacing: 1.2px; color: #555; text-transform: uppercase; margin-bottom: 7px; }
    .v4-dados table { width: 100%; font-size: 11.5px; border-collapse: collapse; color: #E8E8E8; }
    .v4-dados td { padding: 2.5px 0; vertical-align: top; color: #E8E8E8; }
    .v4-dados td:first-child { color: #777; width: 94px; }
    .v4-dados a { color: #7EA6FF; }
    .v4-tag-ok { background: rgba(22,163,74,.22); color: #4ADE80; font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 4px; }
    .v4-tag-al { background: rgba(217,119,6,.24); color: #FBBF24; font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 4px; }
    .v4-farol-motivo { font-size: 9px; line-height: 1.3; margin-top: 3px; opacity: .9; text-align: center; }

    /* ═══ FAROL (v9.8) — destaque forte do veredito ═══ */
    .v4-farol {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      width: 92px; padding: 9px 6px 8px; border-radius: 10px;
      border: 2px solid; line-height: 1;
    }
    .v4-farol-luz { font-size: 26px; line-height: 1; margin-bottom: 4px; }
    .v4-farol-txt {
      font-size: 10px; font-weight: 900; letter-spacing: .8px;
      text-transform: uppercase; text-align: center;
    }
    .v4-farol-sub {
      font-size: 9px; margin-top: 3px; opacity: .8;
      font-variant-numeric: tabular-nums; text-align: center;
    }
    .v4-farol.verde {
      border-color: #16A34A; background: rgba(22,163,74,.16);
      box-shadow: 0 0 20px rgba(22,163,74,.28), inset 0 0 18px rgba(22,163,74,.10);
    }
    .v4-farol.verde .v4-farol-txt { color: #4ADE80; }
    .v4-farol.amarelo {
      border-color: #D97706; background: rgba(217,119,6,.16);
      box-shadow: 0 0 20px rgba(217,119,6,.26), inset 0 0 18px rgba(217,119,6,.10);
    }
    .v4-farol.amarelo .v4-farol-txt { color: #FBBF24; }
    .v4-farol.vermelho {
      border-color: #CC1414; background: rgba(204,20,20,.16);
      box-shadow: 0 0 20px rgba(204,20,20,.30), inset 0 0 18px rgba(204,20,20,.10);
    }
    .v4-farol.vermelho .v4-farol-txt { color: #FCA5A5; }
    .v4-farol.concorrente {
      border-color: #CC1414; background: rgba(204,20,20,.28);
      animation: v4-pulse-red 1.4s ease-in-out infinite;
    }
    .v4-farol.concorrente .v4-farol-txt { color: #FEE2E2; }
    .v4-farol-sub { color: #888; }

    /* borda esquerda do card mais grossa, acompanhando o farol */
    .v4-card.verde { border-left-width: 5px; }
    .v4-card.amarelo { border-left-width: 5px; }
    .v4-card.vermelho { border-left-width: 5px; }

    .v4-badge-concorrente {
      background: #CC1414; color: #fff;
      font-size: 9px; font-weight: 800; letter-spacing: 0.5px;
      padding: 3px 7px; border-radius: 3px; text-transform: uppercase;
      animation: v4-pulse-red 1.6s ease-in-out infinite;
    }
    .v4-badge-socio {
      background: linear-gradient(135deg,#FACC15,#EAB308); color: #422006;
      font-size: 9px; font-weight: 800; letter-spacing: 0.5px;
      padding: 3px 7px; border-radius: 3px; text-transform: uppercase;
    }

    /* ═══ 3 CHECKS ═══ */
    .v4-checks { padding: 0 16px 12px; }
    .v4-check {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 8px 10px; margin-bottom: 5px;
      background: rgba(255,255,255,0.02);
      border-radius: 6px; border-left: 2px solid #2A2A2A;
    }
    .v4-check.ok { border-left-color: #16A34A; background: rgba(22,163,74,0.06); }
    .v4-check.warn { border-left-color: #D97706; background: rgba(217,119,6,0.06); }
    .v4-check.bad { border-left-color: #CC1414; background: rgba(204,20,20,0.06); }
    .v4-check.pending { border-left-color: #444; }
    .v4-check-icon { font-size: 14px; line-height: 1.3; flex-shrink: 0; width: 18px; }
    .v4-check-body { flex: 1; min-width: 0; }
    .v4-check-label {
      font-size: 11px; font-weight: 700; color: #DDD;
      letter-spacing: 0.2px; margin-bottom: 2px;
    }
    .v4-check-detail { font-size: 11px; color: #999; line-height: 1.45; }
    .v4-check-detail a { color: #93C5FD; text-decoration: none; }
    .v4-check-detail a:hover { text-decoration: underline; }

    /* ═══ FIT / PILAR ═══ */
    .v4-fit {
      margin: 0 16px 12px; padding: 10px 12px;
      background: rgba(255,255,255,0.025); border-radius: 6px;
      border: 1px solid #222;
    }
    .v4-fit-label {
      font-size: 9px; font-weight: 700; letter-spacing: 1.5px;
      color: #555; text-transform: uppercase; margin-bottom: 7px;
    }
    .v4-fit-row { font-size: 12px; color: #CCC; line-height: 1.6; }
    .v4-fit-row b { color: #FFF; }
    .v4-fit-yes { color: #4ADE80; font-weight: 700; }
    .v4-fit-no { color: #FCA5A5; }
    .v4-fit-unknown { color: #888; }
    .v4-fit-margem { font-size: 11px; color: #999; margin-top: 5px; }

    /* ═══ AÇÕES ═══ */
    .v4-actions {
      padding: 10px 16px 14px; display: flex; gap: 7px; flex-wrap: wrap;
      border-top: 1px solid #1A1A1A;
    }
    .v4-act {
      padding: 8px 13px; border-radius: 7px; border: 1px solid #2A2A2A;
      background: none; color: #999; font-size: 11px; font-weight: 700;
      cursor: pointer; font-family: inherit; transition: all 0.15s;
    }
    .v4-act:hover { border-color: #555; color: #DDD; background: #1A1A1A; }
    .v4-act-m2 { border-color: #D9770650; color: #F59E0B; }
    .v4-act-m2:hover { border-color: #D97706; background: rgba(217,119,6,0.1); }
    .v4-act-m3 { border-color: #16A34A50; color: #4ADE80; }
    .v4-act-m3:hover { border-color: #16A34A; background: rgba(22,163,74,0.1); }
    .v4-act:disabled { opacity: 0.4; cursor: default; }
    .v4-act.on { border-color: #16A34A; color: #4ADE80; background: rgba(22,163,74,0.12); }

    .v4-outcome-label {
      font-size: 9px; color: #555; letter-spacing: 1px;
      text-transform: uppercase; width: 100%; margin-bottom: 2px;
    }

    /* ═══ SEÇÕES EXPANSÍVEIS (M2/M3) ═══ */
    .v4-sec { margin: 0 16px 12px; }
    .v4-sec-title {
      font-size: 9px; font-weight: 700; letter-spacing: 1.5px;
      color: #555; text-transform: uppercase; margin-bottom: 7px;
      display: flex; align-items: center; gap: 7px;
    }
    .v4-sec-box { color: #E8E8E8;
      padding: 10px 12px; background: #0A0A0A;
      border-radius: 6px; border: 1px solid #1F1F1F;
      max-height: 420px; overflow-y: auto;
    }
    .v4-sec-box::-webkit-scrollbar { width: 5px; }
    .v4-sec-box::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
    .v4-pre {
      font-family: 'IBM Plex Mono','SF Mono',Menlo,monospace;
      font-size: 11px; line-height: 1.75; color: #C4C4C4;
      white-space: pre-wrap; word-break: break-word; margin: 0;
    }
    .v4-loading {
      font-size: 11px; color: #777; padding: 8px;
      display: flex; align-items: center; gap: 9px;
    }
    .v4-spinner {
      width: 12px; height: 12px; border-radius: 50%;
      border: 2px solid #333; border-top-color: #888;
      animation: v4-spin 0.8s linear infinite; flex-shrink: 0;
    }

    .v4-flags {
      margin: 0 16px 12px; padding: 9px 12px;
      background: rgba(217,119,6,0.08);
      border: 1px solid rgba(217,119,6,0.3); border-radius: 6px;
    }
    .v4-flags-title {
      font-size: 10px; font-weight: 700; color: #FBBF24;
      text-transform: uppercase; letter-spacing: 1px; margin-bottom: 5px;
    }
    .v4-flag { font-size: 11px; color: #FDE68A; padding: 2px 0 2px 12px; position: relative; line-height: 1.45; }
    .v4-flag:before { content: "↯"; position: absolute; left: 0; color: #F59E0B; }

    .v4-tags { padding: 0 16px 10px; display: flex; flex-wrap: wrap; gap: 4px; }
    .v4-tag {
      background: rgba(255,255,255,0.04); border: 1px solid #222;
      border-radius: 4px; padding: 3px 7px; color: #888; font-size: 10px;
    }
    .v4-tag b { color: #BBB; }
    .v4-tag-alert { border-color: #D9770640; color: #F59E0B; }

    /* ═══ HEALTH ═══ */
    #v4-health {
      display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
      padding: 8px 22px; border-bottom: 1px solid #1A1A1A; background: #0A0A0A;
    }
    .v4-chip {
      font-size: 10px; font-weight: 700; letter-spacing: .3px;
      padding: 3px 8px; border-radius: 5px; border: 1px solid #2A2A2A;
      color: #999; background: rgba(255,255,255,.03); white-space: nowrap;
    }
    .v4-chip b { color: #ddd; font-weight: 800; }
    .v4-chip-on { border-color: #16A34A40; }
    .v4-chip-off { border-color: #CC141440; background: rgba(204,20,20,.08); }
    .v4-chip-auth { border-color: #D9770640; background: rgba(217,119,6,.08); }
    .v4-chip-warn { border-color: #D9770630; }
    .v4-chip-unset { opacity: .55; cursor: pointer; }
    .v4-chip-unset:hover { opacity: 1; border-color: #D97706; }
    .v4-health-loading { font-size: 10px; color: #777; }
    .v4-health-refresh {
      margin-left: auto; background: none; border: 1px solid #2A2A2A;
      color: #777; width: 24px; height: 24px; border-radius: 5px;
      cursor: pointer; font-size: 12px;
    }
    .v4-health-refresh:hover { border-color: #444; color: #bbb; }
    #v4-fab-badge {
      position: absolute; top: -4px; right: -4px; width: 12px; height: 12px;
      border-radius: 50%; border: 2px solid #0E0E0E; background: #777;
    }
    #v4-dica {
      position: fixed; z-index: 2147483647;
      max-width: 340px; padding: 11px 14px; border-radius: 10px;
      background: #1A1A1A; border: 1px solid #3A3A3A;
      color: #DDD; font-size: 12px; line-height: 1.5;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 10px 34px rgba(0,0,0,.6);
      opacity: 0; transform: translateY(6px); transition: opacity .18s, transform .18s;
      pointer-events: none;
    }
    #v4-dica.on { opacity: 1; transform: translateY(0); }
    #v4-dica b { color: #FBBF24; }

    #v4-fab-count {
      position: absolute; top: -9px; left: -9px;
      min-width: 22px; height: 22px; padding: 0 6px;
      border-radius: 11px; border: 2px solid #0E0E0E;
      background: #fff; color: #CC1414;
      font-size: 11px; font-weight: 900; line-height: 18px;
      text-align: center; font-variant-numeric: tabular-nums;
      box-shadow: 0 2px 8px rgba(0,0,0,.5);
    }

    /* ═══ HISTÓRICO ═══ */
    #v4-hist-overlay {
      display: none; position: fixed !important; inset: 0;
      background: rgba(0,0,0,0.92); z-index: 2147483647 !important;
      backdrop-filter: blur(10px);
    }
    #v4-hist-overlay.active { display: block; }
    #v4-hist-panel {
      position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
      background: #0E0E0E; border: 1px solid #222; border-radius: 16px;
      width: 920px; max-width: 96vw; max-height: 92vh;
      overflow: hidden; display: flex; flex-direction: column;
      font-family: system-ui,-apple-system,sans-serif;
      box-shadow: 0 40px 100px rgba(0,0,0,0.9);
    }
    #v4-hist-header {
      padding: 14px 22px; border-bottom: 1px solid #1E1E1E;
      display: flex; align-items: center; justify-content: space-between; flex-shrink: 0;
    }
    #v4-hist-title {
      display: flex; align-items: center; gap: 10px;
      font-size: 11px; font-weight: 700; color: #666;
      letter-spacing: 2px; text-transform: uppercase;
    }
    #v4-hist-count {
      background: rgba(22,163,74,0.15); color: #4ADE80;
      font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 4px;
    }
    #v4-hist-toolbar {
      padding: 10px 22px; border-bottom: 1px solid #1A1A1A; background: #0A0A0A;
      display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
    }
    #v4-hist-search {
      flex: 1; min-width: 170px; padding: 8px 12px; border-radius: 7px;
      border: 1px solid #2A2A2A; background: #131313; color: #DDD;
      font-size: 12px; font-family: inherit; outline: none;
    }
    #v4-hist-search:focus { border-color: #444; }
    #v4-hist-search::placeholder { color: #555; }
    .v4-hf {
      padding: 7px 11px; border-radius: 7px; border: 1px solid #2A2A2A;
      background: none; color: #888; font-size: 10px; cursor: pointer;
      font-family: inherit; font-weight: 700; transition: all 0.15s;
    }
    .v4-hf:hover { border-color: #444; color: #BBB; }
    .v4-hf.active { border-color: #CC1414; color: #FCA5A5; background: rgba(204,20,20,0.08); }
    #v4-hist-body { flex: 1; overflow-y: auto; padding: 6px 16px 12px; }
    #v4-hist-body::-webkit-scrollbar { width: 6px; }
    #v4-hist-body::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }
    #v4-hist-footer {
      padding: 10px 22px; border-top: 1px solid #1A1A1A; background: #0A0A0A;
      display: flex; gap: 8px; align-items: center;
    }
    .v4-hist-info { flex: 1; font-size: 10px; color: #666; }
    .v4-hrow {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 12px; margin-top: 6px;
      background: #131313; border: 1px solid #1F1F1F;
      border-radius: 8px; cursor: pointer; transition: all 0.15s;
    }
    .v4-hrow:hover { border-color: #333; background: #171717; }
    .v4-hrow.verde { border-left: 3px solid #16A34A; }
    .v4-hrow.amarelo { border-left: 3px solid #D97706; }
    .v4-hrow.vermelho { border-left: 3px solid #CC1414; }
    .v4-hdate {
      font-size: 10px; color: #666; font-weight: 700; white-space: nowrap;
      min-width: 82px; font-variant-numeric: tabular-nums;
    }
    .v4-hmain { flex: 1; min-width: 0; }
    .v4-hname {
      font-size: 12px; font-weight: 700; color: #E4E4E4; margin-bottom: 3px;
      display: flex; align-items: center; gap: 6px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .v4-hsub { font-size: 10px; color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .v4-hchecks { font-size: 13px; white-space: nowrap; letter-spacing: 1px; }
    .v4-hout {
      font-size: 9px; padding: 2px 6px; border-radius: 3px; font-weight: 700;
      text-transform: uppercase; white-space: nowrap;
    }
    .v4-hout-comprei { background: rgba(22,163,74,0.15); color: #4ADE80; }
    .v4-hout-passei { background: rgba(120,120,120,0.15); color: #999; }
    .v4-hout-cliente { background: linear-gradient(135deg,#FACC15,#EAB308); color: #422006; }
    #v4-hist-empty { padding: 60px 24px; text-align: center; color: #444; }
    #v4-hist-empty-icon { font-size: 40px; margin-bottom: 12px; opacity: 0.4; }
    #v4-hist-empty-title { font-size: 13px; font-weight: 700; color: #666; margin-bottom: 6px; }
    #v4-hist-empty-sub { font-size: 11px; line-height: 1.5; }
  `);

  // ═══════════════════════════════════════════════════════════════
  // DOM
  // ═══════════════════════════════════════════════════════════════
  const fab = document.createElement('button');
  fab.id = 'v4-fab';
  fab.innerHTML = '<span style="font-size:14px">🔴</span><span id="v4-fab-label">Analisar Lead</span>';
  fab.title = `V4 Lead Analyzer v${VERSION}\nClique: abre o painel · Com texto marcado: analisa\nCtrl+Shift+V: restaura o painel se sumir`;

  const overlay = document.createElement('div');
  overlay.id = 'v4-overlay';
  overlay.innerHTML = `
    <div id="v4-panel">
      <div id="v4-header">
        <div class="v4-brand">
          <div class="v4-dot"></div>
          <span class="v4-brand-name">V4 Lead Analyzer · v${VERSION}</span>
          <span class="v4-queue-count" id="v4-queue-count" style="display:none">0</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <button id="v4-voltar" title="Voltar para a faixa">← faixa</button>
          <button id="v4-altura" title="Altura do painel">1/5</button>
          <button id="v4-layout-btn" title="Alternar layout">▭</button>
          <button id="v4-close" title="Fechar (ESC)">✕</button>
        </div>
      </div>
      <div id="v4-add-bar">
        <button id="v4-add-btn">+ COLAR LEAD MANUALMENTE</button>
        <button id="v4-clear-queue" title="Limpar cards">🗑 Limpar</button>
      </div>
      <div id="v4-body">
        <div id="v4-rail"></div>
        <div id="v4-cards">
        <div id="v4-producao"></div>
        <div id="v4-empty">
          <div id="v4-empty-icon">🔴</div>
          <div id="v4-empty-title">Nenhum lead na fila</div>
          <div id="v4-empty-sub">
            <b style="color:#4ADE80">⚡ Marque o texto do lead na página</b> — a análise dispara sozinha.<br>
            <span style="opacity:.7">Ou aperte <b>⌘A</b> (Ctrl+A no Windows) — pega a página toda e o script acha o lead sozinho.</span><br>
            <span style="opacity:.7">Não funcionou? Clique em <b>🩺 Diagnóstico</b> no rodapé.</span><br>
            <span style="opacity:.7">O 🔴 flutuante reabre este painel a qualquer momento, sem gastar API.</span><br>
            <span style="opacity:.7">Precisa colar à mão? Use o botão acima.</span><br>
            <span style="opacity:.7">Pode colar vários seguidos — a fila roda ${MAX_PARALLEL} em paralelo e os demais aguardam</span><br><br>
            <b style="color:#888">Momento 1</b> responde em ~7s: concorrente · empresa · decisor<br>
            <b style="color:#888">Momento 2</b> aprofunda se precisar · <b style="color:#888">Momento 3</b> gera dossiê pro SDR
          </div>
        </div>
        </div>
      </div>
      <div id="v4-resize" title="Arraste para redimensionar"></div>
      <div id="v4-resize-tr" title="Arraste para ajustar largura e altura"></div>
      <div id="v4-footer">
        <button class="v4-btn-sec" id="v4-open-hist" style="border-color:#2A4A2A;color:#4ADE80">📚 Histórico</button>
        <button class="v4-btn-sec v4-so-dono" id="v4-add-gemini">+ Chave Gemini</button>
        <button class="v4-btn-sec" id="v4-auto">⚡ Auto</button>
        <button class="v4-btn-sec" id="v4-diag" style="border-color:#3B82F650;color:#93C5FD">🩺 Diagnóstico</button>
        <button class="v4-btn-sec" id="v4-config">⚙ Mais opções</button>
        <span id="v4-tec" class="v4-tec-oculto">
          <button class="v4-btn-sec" id="v4-setup" style="border-color:#3B82F650;color:#93C5FD">🔑 Chaves</button>
          <button class="v4-btn-sec" id="v4-consumo" style="border-color:#16A34A50;color:#4ADE80">📊 Consumo</button>
          <button class="v4-btn-sec" id="v4-auto-m2">🔍 Auto-M2</button>
          <button class="v4-btn-sec v4-so-dono" id="v4-race">⚡⚡ Race</button>
          <button class="v4-btn-sec v4-so-dono" id="v4-model">🔧 Modelo</button>
          <button class="v4-btn-sec v4-so-dono" id="v4-key">🗝 Remover chaves</button>
        </span>
        <button class="v4-btn-sec" id="v4-clear-cache">🗑 Cache</button>
      </div>
    </div>
  `;

  const histOverlay = document.createElement('div');
  histOverlay.id = 'v4-hist-overlay';
  histOverlay.innerHTML = `
    <div id="v4-hist-panel">
      <div id="v4-hist-header">
        <div id="v4-hist-title">
          <div class="v4-dot"></div>
          <span>📚 Histórico</span>
          <span id="v4-hist-count">0</span>
        </div>
        <button id="v4-hist-close" class="v4-btn-sec">✕</button>
      </div>
      <div id="v4-hist-toolbar">
        <input id="v4-hist-search" placeholder="Buscar empresa, contato, cidade, sócio..." />
        <button class="v4-hf active" data-f="todos">Todos</button>
        <button class="v4-hf" data-f="verde">🟢</button>
        <button class="v4-hf" data-f="amarelo">🟡</button>
        <button class="v4-hf" data-f="vermelho">🔴</button>
        <button class="v4-hf" data-f="concorrente">🚨 Concorrentes</button>
        <button class="v4-hf" data-f="comprei">Arrematei</button>
        <button class="v4-hf" data-f="cliente">Virou cliente</button>
      </div>
      <div id="v4-hist-body"></div>
      <div id="v4-hist-footer">
        <div class="v4-hist-info" id="v4-hist-info">— retenção 30 dias</div>
        <button class="v4-btn-sec" id="v4-export-csv">📥 CSV</button>
        <button class="v4-btn-sec" id="v4-export-json">💾 JSON</button>
        <button class="v4-btn-sec" id="v4-hist-clear" style="border-color:#4A2A2A;color:#F87171">🗑 Limpar</button>
      </div>
    </div>
  `;

  function ensureMounted() {
    if (!document.body) return;
    if (!document.body.contains(fab)) document.body.appendChild(fab);
    if (!document.body.contains(overlay)) document.body.appendChild(overlay);
    if (!document.body.contains(histOverlay)) document.body.appendChild(histOverlay);
  }
  ensureMounted();

  const mo = new MutationObserver(() => ensureMounted());
  mo.observe(document.body, { childList: true, subtree: false });
  setInterval(ensureMounted, 3000);

  ['pushState', 'replaceState'].forEach(fn => {
    const orig = history[fn];
    history[fn] = function () {
      const r = orig.apply(this, arguments);
      setTimeout(ensureMounted, 50);
      return r;
    };
  });
  window.addEventListener('popstate', () => setTimeout(ensureMounted, 50));

  const bodyEl = document.getElementById('v4-cards');
  const railEl = document.getElementById('v4-rail');
  const prodEl = document.getElementById('v4-producao');
  const queueCount = document.getElementById('v4-queue-count');

  const queue = [];
  let queueId = 0;
  let processing = 0;
  let v4Health = null;
  let v4HealthAt = 0;

  // ═══════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════
  // MODO FLUTUANTE (v9.12)
  // O painel era modal e escondia o LeadBroker — dava pra analisar ou navegar,
  // nunca os dois. Agora é uma janela ao lado, arrastável e redimensionável.
  // ═══════════════════════════════════════════════════════════════
  const panelEl = () => document.getElementById('v4-panel');

  // ═══════════════════════════════════════════════════════════════
  // LAYOUTS (v9.14) — antes eram dois booleanos independentes
  // (flutuante + recolhido), o que permitia combinações sem sentido.
  // Agora é um estado só, com quatro valores.
  // ═══════════════════════════════════════════════════════════════
  const LAYOUTS = ['rodape', 'split', 'lateral', 'inferior', 'cheia'];
  const LAYOUT_INFO = {
    rodape:   { icone: '▤', nome: 'Rodapé horizontal', dica: 'largo e baixo, embaixo · próximo: janela lateral' },
    split:    { icone: '◫', nome: 'Janela lateral', dica: 'faróis + detalhe, à direita · próximo: faixa lateral' },
    janela:   { icone: '▭', nome: 'Janela flutuante', dica: 'arraste pelo cabeçalho · próximo: rodapé' },
    lateral:  { icone: '▯', nome: 'Faixa lateral', dica: 'só os faróis, à direita · próximo: faixa inferior' },
    inferior: { icone: '▁', nome: 'Faixa inferior', dica: 'só os faróis, embaixo · próximo: tela cheia' },
    cheia:    { icone: '⛶', nome: 'Tela cheia', dica: 'cobre a página · próximo: janela flutuante' },
  };

  function layout() {
    const l = GM_getValue('v4_layout', '');
    if (LAYOUTS.includes(l)) return l;
    // migra as preferências antigas
    if (GM_getValue('v4_recolhido', '0') === '1') return 'lateral';
    if (GM_getValue('v4_flutuante', '1') === '0') return 'cheia';
    return 'rodape';
  }

  function setLayout(l) { GM_setValue('v4_layout', l); aplicarLayout(); }

  // v9.20: altura do rodapé em fração da tela. Fixo em 380px cobria metade de
  // um MacBook e escondia a grade de cards, que é onde ela escolhe os leads.
  const ALTURAS = [
    { f: '1/6', vh: 16 },
    { f: '1/5', vh: 20 },
    { f: '1/4', vh: 25 },
    { f: '1/3', vh: 33 },
    { f: '1/2', vh: 50 },
  ];

  function alturaIdx() {
    const i = parseInt(GM_getValue('v4_altura_idx', '1'), 10);
    return (i >= 0 && i < ALTURAS.length) ? i : 1;   // padrão 1/5
  }

  function aplicarAltura() {
    const a = ALTURAS[alturaIdx()];
    const p = panelEl();
    if (p) {
      const hSalva = GM_getValue('v4_rodape_h', '');
      p.style.setProperty('--v4-rodape-h', hSalva ? hSalva + 'px' : a.vh + 'vh');
      // largura salva pelo arraste da alça; 62vw se nunca ajustou
      const w = GM_getValue('v4_rodape_w', '');
      p.style.setProperty('--v4-rodape-w', w ? w + 'px' : '62vw');
    }
    const hSalvaPx = parseInt(GM_getValue('v4_rodape_h', ''), 10);
    const hEfetiva = hSalvaPx || (window.innerHeight * a.vh / 100);
    overlay.classList.toggle('baixo', hEfetiva <= window.innerHeight * 0.21);
    const b = document.getElementById('v4-altura');
    if (b) {
      b.textContent = a.f;
      b.title = `Painel ocupa ${a.f} da tela — clique para aumentar`;
    }
  }

  function ciclarAltura() {
    GM_setValue('v4_rodape_h', '');   // o botão de fração manda: descarta o arraste
    GM_setValue('v4_altura_idx', String((alturaIdx() + 1) % ALTURAS.length));
    aplicarAltura();
  }

  // v9.15: a faixa é a base de trabalho. Clicar num card entra no detalhe;
  // o botão "← faixa" devolve pro layout de onde você veio.
  // Sem isso, expandir o card deixava você preso no modo janela.
  let faixaAnterior = null;

  function entrarNoDetalhe(cardEl) {
    const l = layout();
    if (l !== 'lateral' && l !== 'inferior') return false;
    faixaAnterior = l;
    overlay.classList.add('veio-da-faixa');
    setLayout('janela');
    setTimeout(() => {
      if (cardEl) { cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); piscarCard(cardEl); }
    }, 140);
    return true;
  }

  function voltarParaFaixa() {
    overlay.classList.remove('veio-da-faixa');
    setLayout(faixaAnterior || 'inferior');
    faixaAnterior = null;
  }

  function ciclarLayout() {
    overlay.classList.remove('veio-da-faixa');
    faixaAnterior = null;
    const i = LAYOUTS.indexOf(layout());
    // 'janela' não está no ciclo (é alcançável só por preferência antiga) → volta pro início
    setLayout(i < 0 ? LAYOUTS[0] : LAYOUTS[(i + 1) % LAYOUTS.length]);
  }

  // compat com o resto do código
  // layouts com trilha de faróis + detalhe
  function temTrilha() { const l = layout(); return l === 'split' || l === 'rodape'; }

  function modoFlutuante() { return layout() !== 'cheia'; }
  function recolhido() { const l = layout(); return l === 'lateral' || l === 'inferior'; }

  function aplicarLayout() {
    const l = layout();
    overlay.classList.toggle('flutuante', l !== 'cheia');
    overlay.classList.toggle('recolhido', l === 'lateral');
    overlay.classList.toggle('inferior', l === 'inferior');
    overlay.classList.toggle('split', l === 'split');
    overlay.classList.toggle('rodape', l === 'rodape');
    aplicarAltura();
    if (temTrilha()) { renderRail(); renderProducao(); }

    const b = document.getElementById('v4-layout-btn');
    if (b) {
      const info = LAYOUT_INFO[l];
      b.textContent = info.icone;
      b.title = `${info.nome} — ${info.dica}`;
    }

    const p = panelEl();
    if (!p) return;
    // limpa inline styles antes de aplicar o layout
    p.style.top = p.style.left = p.style.right = p.style.bottom = '';
    p.style.width = p.style.height = '';

    if (l === 'janela' || l === 'split') restaurarGeometria();
    else if (l === 'lateral') {
      p.style.left = 'auto'; p.style.right = '16px'; p.style.top = '16px';
      p.style.height = 'calc(100vh - 32px)';
    }
    // 'inferior' e 'cheia' são resolvidos só por CSS
  }

  function salvarGeometria() {
    const p = panelEl();
    const lay = layout();
    if (!p || (lay !== 'janela' && lay !== 'split')) return;
    const r = p.getBoundingClientRect();
    GM_setValue('v4_geo', JSON.stringify({
      top: Math.round(r.top), left: Math.round(r.left),
      w: Math.round(r.width), h: Math.round(r.height),
    }));
  }

  function restaurarGeometria() {
    const p = panelEl();
    if (!p) return;
    let g = null;
    try { g = JSON.parse(GM_getValue('v4_geo', '') || 'null'); } catch (e) {}
    if (!g) return;
    // não deixa a janela sumir se a resolução mudou
    const w = Math.min(Math.max(g.w, 380), window.innerWidth - 20);
    const h = Math.min(Math.max(g.h, 260), window.innerHeight - 20);
    const left = Math.min(Math.max(g.left, 0), window.innerWidth - 120);
    const top = Math.min(Math.max(g.top, 0), window.innerHeight - 60);
    p.style.width = w + 'px';
    p.style.height = h + 'px';
    p.style.left = left + 'px';
    p.style.top = top + 'px';
    p.style.right = 'auto';
  }

  // Arrastar funciona na janela livre e na faixa inferior (reposiciona a doca)
  function iniciarArraste(e) {
    const l = layout();
    if (l === 'cheia' || l === 'lateral') return;
    if (e.target.closest('button')) return;
    const p = panelEl();
    if (!p) return;
    const r = p.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    p.style.right = 'auto';
    p.style.bottom = 'auto';
    if (l === 'inferior') { p.style.width = r.width + 'px'; }
    overlay.classList.add('arrastando');

    const mover = ev => {
      p.style.left = Math.min(Math.max(ev.clientX - dx, -r.width + 120), window.innerWidth - 120) + 'px';
      p.style.top = Math.min(Math.max(ev.clientY - dy, 0), window.innerHeight - 50) + 'px';
    };
    const soltar = () => {
      document.removeEventListener('mousemove', mover, true);
      document.removeEventListener('mouseup', soltar, true);
      overlay.classList.remove('arrastando');
      salvarGeometria();
    };
    document.addEventListener('mousemove', mover, true);
    document.addEventListener('mouseup', soltar, true);
    e.preventDefault();
  }

  // v9.21: alça do rodapé — cresce pra direita e pra cima, sem sair da âncora
  function iniciarResizeRodape(e) {
    if (layout() !== 'rodape') return;
    const p = panelEl();
    if (!p) return;
    const r = p.getBoundingClientRect();
    const x0 = e.clientX, y0 = e.clientY, w0 = r.width, h0 = r.height;
    overlay.classList.add('arrastando');

    const mover = ev => {
      const w = Math.min(Math.max(w0 + (ev.clientX - x0), 460), window.innerWidth - 24);
      const h = Math.min(Math.max(h0 - (ev.clientY - y0), 150), window.innerHeight * 0.7);
      p.style.setProperty('--v4-rodape-w', w + 'px');
      p.style.setProperty('--v4-rodape-h', h + 'px');
      overlay.classList.toggle('baixo', h <= window.innerHeight * 0.21);
    };
    const soltar = () => {
      document.removeEventListener('mousemove', mover, true);
      document.removeEventListener('mouseup', soltar, true);
      overlay.classList.remove('arrastando');
      const rr = p.getBoundingClientRect();
      GM_setValue('v4_rodape_w', String(Math.round(rr.width)));
      // altura vira px fixo; o botão de fração continua funcionando e sobrescreve
      GM_setValue('v4_rodape_h', String(Math.round(rr.height)));
    };
    document.addEventListener('mousemove', mover, true);
    document.addEventListener('mouseup', soltar, true);
    e.preventDefault();
  }

  function iniciarResize(e) {
    const lay = layout();
    if (lay !== 'janela' && lay !== 'split') return;
    const p = panelEl();
    if (!p) return;
    const r = p.getBoundingClientRect();
    const x0 = e.clientX, y0 = e.clientY, w0 = r.width, h0 = r.height, l0 = r.left;
    p.style.right = 'auto';
    overlay.classList.add('arrastando');

    const mover = ev => {
      const w = Math.min(Math.max(w0 + (x0 - ev.clientX), 380), window.innerWidth - 20);
      const h = Math.min(Math.max(h0 + (ev.clientY - y0), 260), window.innerHeight - 20);
      p.style.width = w + 'px';
      p.style.height = h + 'px';
      p.style.left = (l0 - (w - w0)) + 'px';
    };
    const soltar = () => {
      document.removeEventListener('mousemove', mover, true);
      document.removeEventListener('mouseup', soltar, true);
      overlay.classList.remove('arrastando');
      salvarGeometria();
    };
    document.addEventListener('mousemove', mover, true);
    document.addEventListener('mouseup', soltar, true);
    e.preventDefault();
  }

  // v9.36: abrir o painel NUNCA pode falhar. Se o cálculo de layout quebrar ou
  // a geometria salva deixar a janela fora da tela, o usuário via só o botão
  // "funcionando" e nada acontecendo. Agora o painel se conserta sozinho.
  function openPanel() {
    overlay.classList.add('active');
    try { aplicarLayout(); }
    catch (e) {
      console.error('[V4] aplicarLayout falhou — usando layout de emergência:', e);
      layoutEmergencia();
    }
    setTimeout(verificarVisibilidade, 60);
  }

  function layoutEmergencia() {
    const p = panelEl();
    overlay.classList.remove('recolhido', 'inferior', 'split', 'rodape', 'baixo');
    overlay.classList.add('flutuante');
    if (!p) return;
    p.style.cssText += ';top:auto;bottom:16px;left:16px;right:auto;'
      + 'width:min(900px,92vw);height:min(420px,60vh);transform:none';
  }

  // Se o painel abriu com tamanho zero ou fora da tela, reseta pro padrão.
  function verificarVisibilidade() {
    const p = panelEl();
    if (!p || !overlay.classList.contains('active')) return;
    const r = p.getBoundingClientRect();
    const invisivel = r.width < 120 || r.height < 80
      || r.right < 40 || r.bottom < 40
      || r.left > window.innerWidth - 40 || r.top > window.innerHeight - 40;
    if (!invisivel) return;

    console.warn('[V4] painel abriu invisível', {
      w: Math.round(r.width), h: Math.round(r.height),
      left: Math.round(r.left), top: Math.round(r.top),
    });
    // limpa preferências que podem ter causado isso e volta ao padrão
    GM_setValue('v4_geo', '');
    GM_setValue('v4_rodape_w', '');
    GM_setValue('v4_rodape_h', '');
    GM_setValue('v4_layout', 'rodape');
    GM_setValue('v4_altura_idx', '1');
    try { aplicarLayout(); } catch (e) { layoutEmergencia(); }

    setTimeout(() => {
      const r2 = p.getBoundingClientRect();
      if (r2.width < 120 || r2.height < 80) layoutEmergencia();
    }, 60);
  }
  function closePanel() { overlay.classList.remove('active'); }
  // v9.16: a IA devolve "[texto](url)" ou "www.x.com.br" sem protocolo.
  // Sem normalizar, o href relativo virava brokers.mktlab.app/www.x.com.br
  function normalizarUrl(u) {
    if (!u) return null;
    let s = String(u).trim();
    const md = s.match(/\[[^\]]*\]\(([^)]+)\)/);   // markdown
    if (md) s = md[1].trim();
    s = s.replace(/[<>"'\s]/g, '');
    if (!s) return null;
    // tira prefixo indevido de domínio da página
    s = s.replace(/^https?:\/\/[^/]*mktlab\.app\//i, '');
    if (!/^https?:\/\//i.test(s)) {
      if (!/^[\w.-]+\.[a-z]{2,}/i.test(s)) return null;
      s = 'https://' + s;
    }
    try { new URL(s); } catch (e) { return null; }
    return s;
  }

  function textoUrl(u) {
    return String(u || '').replace(/^https?:\/\//i, '').replace(/\/$/, '');
  }

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function getOpenAIKey() {
    let k = GM_getValue('v4_openai_key', '');
    if (k) return k;
    marcarDono();   // quem digita a chave é quem administra
    k = prompt('🔴 Chave OpenAI (obrigatória)\n\nCole sua chave (sk-...)\nplatform.openai.com/api-keys');
    if (!k || !k.trim().startsWith('sk-')) { alert('Chave inválida.'); return null; }
    GM_setValue('v4_openai_key', k.trim());
    return k.trim();
  }

  function askGeminiKey() {
    const k = prompt('🔍 Chave Gemini (recomendada — roda em paralelo com GPT)\n\nCole sua chave (AIza...)\naistudio.google.com/apikey\n\n⚠️ Ative billing pra evitar "high demand".');
    if (!k || !k.trim() || k.trim().length < 20) return null;
    GM_setValue('v4_gemini_key', k.trim());
    v4Health = null;
    return k.trim();
  }

  // ═══════════════════════════════════════════════════════════════
  // SETUP EM 1 COLAGEM (v9.1)
  // Permite ao gestor distribuir as chaves do time num código único, em vez de
  // cada pessoa pegar 3 chaves em 3 sites.
  // ⚠️ O código NÃO é criptografia — é só codificação, pra não trafegar a chave
  //    em texto puro. Trate como senha: mande por canal privado, nunca em repo,
  //    nunca em canal público de Slack/WhatsApp.
  // ═══════════════════════════════════════════════════════════════
  // v9.23: só a máquina que configurou as chaves À MÃO pode gerar o código de
  // distribuição. Quem recebeu por código não vira distribuidor.
  // ⚠️ Isso reduz repasse acidental, NÃO é segurança: as chaves ficam no storage
  // do Tampermonkey da máquina e são legíveis por quem souber onde olhar.
  // A proteção real é o teto de gasto na conta da OpenAI.
  // v9.27 FIX: a v9.23 exigia v4_dono === '1', mas quem já tinha as chaves
  // configuradas de versões anteriores nunca recebeu essa marca — e ficava
  // sem poder gerar o código de distribuição.
  // Agora só NÃO é dono quem foi explicitamente configurado por código ('0').
  function souDono() { return GM_getValue('v4_dono', '') !== '0'; }
  function marcarDono() { GM_setValue('v4_dono', '1'); }

  function gerarCodigoSetup() {
    if (!souDono()) {
      alert('🔒 Só a máquina que configurou as chaves manualmente pode gerar o código '
          + 'de distribuição.\n\nEsta máquina recebeu as chaves por código.\n\n'
          + 'Se precisar do código, peça a quem administra as chaves.');
      return null;
    }
    const cfg = {
      serper: GM_getValue('v4_serper_key', ''),
      ghlToken: GM_getValue('v4_ghl_token', ''),
      ghlLocation: GM_getValue('v4_ghl_location', ''),
      v: 1,
      openai: GM_getValue('v4_openai_key', ''),
      gemini: GM_getValue('v4_gemini_key', ''),
      outbound: GM_getValue('v4_outbound_token', ''),
      sheet: GM_getValue('v4_sheet_url', ''),   // v13.0: histórico central da unidade
      por: 'V4 · unidade',
      em: new Date().toISOString().slice(0, 10),
    };
    if (!cfg.openai) { alert('Configure a chave da OpenAI antes de gerar o código.'); return null; }
    try {
      return 'V4CFG1.' + btoa(unescape(encodeURIComponent(JSON.stringify(cfg))));
    } catch (e) { alert('Erro ao gerar: ' + e.message); return null; }
  }

  function aplicarCodigoSetup(codigo) {
    const txt = String(codigo || '').trim();
    if (!txt.startsWith('V4CFG1.')) return { ok: false, erro: 'Código inválido — deve começar com V4CFG1.' };
    try {
      const cfg = JSON.parse(decodeURIComponent(escape(atob(txt.slice(7)))));
      if (!cfg.openai || !String(cfg.openai).startsWith('sk-')) {
        return { ok: false, erro: 'O código não contém uma chave OpenAI válida.' };
      }
      GM_setValue('v4_openai_key', cfg.openai);
      if (cfg.gemini) GM_setValue('v4_gemini_key', cfg.gemini);
      if (cfg.serper) GM_setValue('v4_serper_key', cfg.serper);
      if (cfg.ghlToken) GM_setValue('v4_ghl_token', cfg.ghlToken);
      if (cfg.ghlLocation) GM_setValue('v4_ghl_location', cfg.ghlLocation);
      if (cfg.outbound) { GM_setValue('v4_outbound_token', cfg.outbound); GM_setValue('v4_ob_asked', '1'); }
      if (cfg.sheet) GM_setValue('v4_sheet_url', cfg.sheet);   // v13.0: histórico central
      GM_setValue('v4_openai_search_ok', '');
      GM_setValue('v4_dono', '0');   // recebeu por código → não é distribuidor
      v4Health = null;
      // com planilha configurada, precisa saber quem está usando
      if (cfg.sheet) pedirNomeUsuario(true);
      return {
        ok: true,
        temGemini: !!cfg.gemini,
        temOutbound: !!cfg.outbound,
        temSheet: !!cfg.sheet,
        em: cfg.em || '?',
      };
    } catch (e) { return { ok: false, erro: 'Código corrompido ou incompleto.' }; }
  }

  function getOutboundToken() {
    let k = GM_getValue('v4_outbound_token', '');
    if (k) return k;
    k = prompt('🔵 Token OutboundPro (opcional — enriquece quando há CNPJ)\n\nCole seu token ou Cancelar pra pular.\nOutboundPro → Configurações → API Token');
    if (!k || !k.trim() || k.trim().length < 10) return null;
    GM_setValue('v4_outbound_token', k.trim());
    return k.trim();
  }

  // ═══════════════════════════════════════════════════════════════
  // CACHE / HISTÓRICO
  // ═══════════════════════════════════════════════════════════════
  // Normaliza antes do hash: seleções com espaços/quebras diferentes viravam
  // hashes distintos e o mesmo lead entrava duas vezes na fila.
  function normalizarParaHash(t) {
    return String(t || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9@.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function hashLead(t) {
    const n = normalizarParaHash(t);
    let h = 0;
    for (let i = 0; i < n.length; i++) { h = ((h << 5) - h) + n.charCodeAt(i); h |= 0; }
    return 'lead_' + Math.abs(h).toString(36);
  }

  // ═══════════════════════════════════════════════════════════════
  // IDENTIDADE DO LEAD (v8.20)
  // Selecionar pedaços diferentes do mesmo lead gerava textos diferentes e o
  // dedupe por hash de texto não pegava. A identidade real é empresa + contato
  // + e-mail/telefone — se qualquer âncora forte bate, é o mesmo lead.
  // ═══════════════════════════════════════════════════════════════
  function chaveIdentidade(texto) {
    let ex;
    try { ex = preExtract(texto); } catch (e) { return null; }
    const norm = s => normalizarParaHash(s || '');
    const emp = norm(ex.nomeEmpresa).replace(/\b(ltda|me|epp|eireli|sa|s a|comercio|servicos)\b/g, '').trim();
    const email = (ex.email && !/\*{2,}/.test(ex.email)) ? norm(ex.email) : '';
    const tel = ex.telefone ? String(ex.telefone).replace(/\D/g, '').slice(-9) : '';
    const cnpj = ex.cnpjVisivel && ex.cnpj ? ex.cnpj.replace(/\D/g, '') : '';
    // v14.16: contato e cidade entram na identidade. Sem eles, dois leads
    // diferentes com nome parecido viravam o mesmo — e o segundo era bloqueado.
    const contato = norm(ex.nomeContato || '');
    const cidade = norm(ex.cidade || (ex.regiao ? ex.regiao.praca : ''));
    if (!emp && !email && !tel && !cnpj) return null;
    return { emp, email, tel, cnpj, contato, cidade };
  }

  // Duas identidades são o mesmo lead se alguma âncora forte coincide
  // v14.16: bloquear um lead novo é o erro mais caro que existe — a pessoa perde
  // o leilão. Caso real: "GP Veículos de Uberaba" era barrado por um "GP Veículos"
  // analisado antes, e duas drogarias de mesmo nome em cidades diferentes viravam
  // o mesmo lead. Agora o nome da empresa só bloqueia se nada CONTRADIZER.
  function mesmaIdentidade(a, b) {
    if (!a || !b) return false;

    // provas fortes e únicas de cada lead
    if (a.cnpj && b.cnpj) return a.cnpj === b.cnpj;
    if (a.email && b.email && a.email === b.email) return true;
    if (a.tel && b.tel && a.tel.length >= 8 && a.tel === b.tel) return true;

    // contato diferente = lead diferente, mesmo com a empresa de mesmo nome
    if (a.contato && b.contato && a.contato !== b.contato) return false;
    // cidade diferente = lead diferente
    if (a.cidade && b.cidade && a.cidade !== b.cidade) return false;

    if (a.emp && b.emp && a.emp.length >= 5) {
      if (a.emp === b.emp) return true;
      // ⚠️ substring só vale se um dos dois confirmar (contato ou cidade batendo).
      // "GP Veículos" ⊂ "GP Veículos de Uberaba" não basta sozinho.
      const confirma = (a.contato && a.contato === b.contato) || (a.cidade && a.cidade === b.cidade);
      if (confirma && (a.emp.includes(b.emp) || b.emp.includes(a.emp))) return true;
    }
    return false;
  }

  // Textos "reservados" entre o clique e o addLead. Sem isso, dois disparos
  // rápidos passavam os dois pela checagem porque a fila ainda estava vazia
  // (havia um await de health check no meio).
  const reservados = new Map();     // hash -> texto normalizado
  const idsReservados = new Map();  // hash -> identidade do lead

  function textosEmUso() {
    return [
      ...queue.map(q => normalizarParaHash(q.rawText)),
      ...reservados.values(),
    ];
  }

  // Hash exato, subconjunto de texto, OU mesma identidade de lead
  function duplicataNaFila(texto) {
    const h = hashLead(texto);
    if (reservados.has(h)) return true;
    if (queue.some(q => hashLead(q.rawText) === h)) return true;

    const n = normalizarParaHash(texto);
    if (n.length >= 30 && textosEmUso().some(nq => nq.includes(n) || n.includes(nq))) return true;

    // v8.20: mesma empresa/e-mail/telefone = mesmo lead, ainda que a seleção difira
    const id = chaveIdentidade(texto);
    if (!id) return false;
    if ([...idsReservados.values()].some(x => mesmaIdentidade(id, x))) return true;
    return queue.some(q => mesmaIdentidade(id, q.identidade || chaveIdentidade(q.rawText)));
  }

  // Qual entrada da fila corresponde a este texto?
  function acharNaFila(texto) {
    const h = hashLead(texto);
    let e = queue.find(q => hashLead(q.rawText) === h);
    if (e) return e;
    const id = chaveIdentidade(texto);
    if (!id) return null;
    return queue.find(q => mesmaIdentidade(id, q.identidade || chaveIdentidade(q.rawText))) || null;
  }

  // Reserva o texto imediatamente (síncrono). Retorna false se já estava reservado.
  function reservar(texto) {
    if (duplicataNaFila(texto)) return false;
    const h = hashLead(texto);
    reservados.set(h, normalizarParaHash(texto));
    const id = chaveIdentidade(texto);
    if (id) idsReservados.set(h, id);
    return true;
  }

  function liberar(texto) {
    const h = hashLead(texto);
    reservados.delete(h);
    idsReservados.delete(h);
  }

  // v8.16: já foi analisado alguma vez nos últimos 30 dias?
  // Antes só checávamos a fila — lead do dia anterior era reanalisado sem aviso.
  function analisadoAntes(texto) {
    const direto = getCached(texto);
    if (direto && direto.m1) return { quando: direto.timestamp, dados: direto, exato: true };

    if (typeof GM_listValues === 'undefined') return null;
    const n = normalizarParaHash(texto);
    const id = chaveIdentidade(texto);
    if (n.length < 20 && !id) return null;

    const agora = Date.now();
    let melhor = null;
    for (const k of GM_listValues()) {
      if (!k.startsWith('lead_')) continue;
      const raw = GM_getValue(k, '');
      if (!raw) continue;
      try {
        const d = JSON.parse(raw);
        if (!d.m1 || !d.rawText) continue;
        if (agora - d.timestamp >= HISTORY_TTL_MS) continue;

        // texto sobreposto
        const nq = normalizarParaHash(d.rawText);
        if (n.length >= 30 && (nq.includes(n) || n.includes(nq))) {
          // v14.10: se a seleção NOVA contém a antiga e traz campos que faltavam,
          // reanalisa em vez de devolver o resultado parcial.
          // Sintoma: soltar o mouse no meio do arraste analisava o pedaço; refazer
          // a seleção certa devolvia o card ruim dizendo "já analisado".
          if (n.includes(nq) && n.length > nq.length * 1.15) {
            const antigo = d.extracted || {};
            const novo = preExtract(texto);
            const ganhou = ['nomeContato', 'email', 'telefone', 'faturamento', 'cidade', 'segmento']
              .some(c => !antigo[c] && novo[c]);
            if (ganhou) {
              try { GM_setValue(k, ''); } catch (e) {}   // descarta o parcial
              continue;
            }
          }
          return { quando: d.timestamp, dados: d, exato: false, via: 'texto' };
        }
        // v8.20: mesma identidade de lead (empresa / e-mail / telefone / CNPJ)
        if (id && mesmaIdentidade(id, chaveIdentidade(d.rawText))) {
          if (!melhor || d.timestamp > melhor.quando) {
            melhor = { quando: d.timestamp, dados: d, exato: false, via: 'identidade' };
          }
        }
      } catch (e) {}
    }
    return melhor;
  }

  function quandoTexto(ts) {
    const dias = Math.floor((Date.now() - ts) / 86400000);
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    if (dias === 0) return `hoje às ${hh}`;
    if (dias === 1) return `ontem às ${hh}`;
    return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')} às ${hh} (${dias} dias atrás)`;
  }

  function getCached(t) {
    const raw = GM_getValue(hashLead(t), null);
    if (!raw) return null;
    try {
      const d = JSON.parse(raw);
      if (Date.now() - d.timestamp < HISTORY_TTL_MS) return d;
    } catch (e) { }
    return null;
  }

  function saveEntry(entry) {
    const key = hashLead(entry.rawText);
    const ex = entry.extracted || {};
    const m1 = entry.m1 || {};
    const meta = {
      empresa: ex.nomeEmpresa || null,
      contato: ex.nomeContato || null,
      cidade: ex.cidade || null,
      estado: ex.estado || null,
      tier: ex.tier || null,
      canal: ex.canal || null,
      segmento: ex.segmento || null,
      isConcorrente: m1.is_concorrente === true,
      empresaExiste: m1.empresa_existe || null,
      decisor: m1.decisor_status || m1.decisor_confirmado || null,
      decisorPapel: m1.decisor_papel || null,
      ramoReal: (entry.m2 && entry.m2.ramo_real) || m1.ramo_aparente || null,
      cnpj: entry.cnpjResolvido || null,
      socioQsa: !!(entry.qsaMatch),
      // v16.8: as cores dos 4 boxes vão pro histórico, senão ele recalcula por
      // conta própria e diverge do card — mesmo lead mostrando resultados
      // diferentes em dois lugares.
      boxes: entry.boxes ? {
        concorrente: entry.boxes.concorrente.cor,
        empresa: entry.boxes.empresa.cor,
        decisor: entry.boxes.decisor.cor,
        margem: entry.boxes.margem.cor,
      } : null,
      margemBucket: entry.matriz && entry.matriz.marg ? entry.matriz.marg.bucket : null,
      margemNome: entry.matriz && entry.matriz.marg ? entry.matriz.marg.nome : null,
      margemFaixa: entry.matriz && entry.matriz.faixa ? entry.matriz.faixa.rot : null,
      farol: entry.farol ? entry.farol.rot : null,
      // v14.8: quem analisou e os campos que o CSV precisava
      usuario: nomeUsuario(),
      faturamento: ex.faturamento || null,
      cnae: (entry.oficial && entry.oficial.cnae) || null,
      outcome: entry.outcome || null,
    };
    GM_setValue(key, JSON.stringify({
      rawText: entry.rawText,
      extracted: entry.extracted || null,
      m1: entry.m1 || null,
      m2: entry.m2 || null,
      m3: entry.m3 || null,
      oficial: entry.oficial || null,
      qsaMatch: entry.qsaMatch || null,
      parentesco: entry.parentesco || null,
      coerenciaPorte: entry.coerenciaPorte || null,
      alertaCapital: entry.alertaCapital || null,
      cnpjResolvido: entry.cnpjResolvido || null,
      matriz: entry.matriz || null,
      divSegmento: entry.divSegmento || null,
      emailPorte: entry.emailPorte || null,
      sub: entry.sub || null,
      outcome: entry.outcome || null,
      meta,
      timestamp: Date.now(),
    }));
  }

  function clearAllCache() {
    if (typeof GM_listValues !== 'undefined') {
      GM_listValues().forEach(k => { if (k.startsWith('lead_')) GM_setValue(k, ''); });
    }
  }

  function listHistory() {
    if (typeof GM_listValues === 'undefined') return [];
    const out = [];
    const now = Date.now();
    GM_listValues().forEach(k => {
      if (!k.startsWith('lead_')) return;
      const raw = GM_getValue(k, '');
      if (!raw) return;
      try {
        const d = JSON.parse(raw);
        if (now - d.timestamp >= HISTORY_TTL_MS) return;
        if (!d.meta) return;
        out.push({ key: k, ...d });
      } catch (e) { }
    });
    out.sort((a, b) => b.timestamp - a.timestamp);
    return out;
  }

  function fmtHistDate(ts) {
    const d = new Date(ts), now = new Date();
    const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
    if (d.toDateString() === now.toDateString()) return `Hoje ${hh}:${mm}`;
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return `Ontem ${hh}:${mm}`;
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${hh}:${mm}`;
  }

  // ═══════════════════════════════════════════════════════════════
  // PARSE DO E-MAIL — destrava sobrenome e nome real da empresa
  // ═══════════════════════════════════════════════════════════════
  const DOMINIOS_GENERICOS = ['gmail', 'hotmail', 'outlook', 'yahoo', 'live', 'icloud', 'bol', 'uol', 'terra', 'globo', 'me', 'msn', 'protonmail', 'zipmail', 'ig'];

  function parseEmail(email) {
    const out = {
      valido: false, local: null, dominio: null, dominioFull: null,
      corporativo: null, sobrenomeExtraido: null, nomeExtraido: null,
      empresaProvavel: null, notas: [],
    };
    if (!email || !email.includes('@') || /\*{2,}/.test(email)) return out;

    const parts = String(email).trim().toLowerCase().split('@');
    if (parts.length !== 2) return out;

    out.valido = true;
    out.local = parts[0];
    out.dominioFull = parts[1];
    out.dominio = parts[1].split('.')[0];
    out.corporativo = !DOMINIOS_GENERICOS.includes(out.dominio);

    // Nome/sobrenome do local part: joao.pereira / joao_pereira / joaopereira-silva
    const tokens = out.local.split(/[._\-+]/).filter(t => t.length > 1 && !/^\d+$/.test(t));
    if (tokens.length >= 2) {
      out.nomeExtraido = cap(tokens[0]);
      out.sobrenomeExtraido = cap(tokens[tokens.length - 1]);
      out.notas.push(`e-mail sugere: ${out.nomeExtraido} ${out.sobrenomeExtraido}`);
    } else if (tokens.length === 1) {
      out.nomeExtraido = cap(tokens[0]);
    }

    if (out.corporativo) {
      out.empresaProvavel = out.dominio;
      out.notas.push(`domínio corporativo "${out.dominioFull}" — provável nome real da empresa`);
    }

    return out;
  }

  function cap(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }

  // ═══════════════════════════════════════════════════════════════
  // PARSER DO LEAD
  // ═══════════════════════════════════════════════════════════════
  function parseValorBR(token) {
    let t = String(token).toLowerCase().replace(/r\$\s*/g, '').trim();
    let mult = 1;
    // "k" e "mi" colados no número não têm word boundary — trata separado
    if (/milh(?:ão|ões|ao|oes)|\bmi\b|\d\s*mi\b/.test(t)) mult = 1000000;
    else if (/\bmil\b|\bk\b|\d\s*k\b/.test(t)) mult = 1000;
    const n = parseFloat(t.replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.'));
    if (isNaN(n)) return 0;
    return Math.round(n * mult);
  }

  // Rejeita "nome de empresa" que na verdade é lixo de UI: "#2", "✅", "Lead",
  // números soltos, só símbolos, uma letra.
  // v15.2: esta função voltou à versão fraca quando a v11 foi reconstruída sobre
  // a v9.37, e o bug dos cards "#2" e "✅ Concorrente" reapareceu sem ninguém
  // notar. A suíte de regressão pegou. Versão reforçada restaurada.
  function nomeEmpresaPlausivel(n) {
    if (!n) return false;
    let s = String(n).trim();
    // tira emoji e símbolo de UI colados na frente ("✅ Concorrente", "🚨 x")
    s = s.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}✅✕⚠🚨🟢🟡🔴⏳↺↯◉⚡✓#•·\-–—\s]+/u, '').trim();
    if (s.length < 2) return false;
    if (/^#?\d+$/.test(s)) return false;
    if ((s.match(/[a-zA-ZÀ-ÿ]/g) || []).length < 2) return false;   // "R&F" passa

    // rótulos e textos da UI do próprio script
    // v16.2: com Cmd+A, o título do próprio painel e os chips de status entram
    // na seleção. Nada disso é nome de empresa.
    const LIXO = /^(lead|leads|novo|analisar|limpar|hist[óo]rico|cache|chaves|modelo|auto|resultado|resumo|decisor|concorrente|empresa|margem|produ[çc][ãa]o|farol|detalhes|visualizado|arrematador|denunciar|ver no crm|dados encontrados|valor atual|faturamento|segmento|canal|cargo|telefone|urg[êe]ncia|estado|cidade|pa[íi]s|enriquecimento|descri[çc][ãa]o|v4 lead analyzer|colar lead|openai|gemini|outboundpro|brasilapi|depositar|ofertas|adicionar filtro|fa[çc]a sua oferta|dar lance|diagn[óo]stico|mais op[çc][õo]es|consumo|race|ver an[áa]lises)\b/i;
    if (LIXO.test(s)) return false;

    // VALORES de campo não são nome de empresa
    if (/^(de\s+)?\d+\s*(mil|milh[õo])/i.test(s)) return false;
    if (/^(acima|at[ée])\s+de\s+/i.test(s)) return false;
    if (/^n[ãa]o informad/i.test(s)) return false;
    if (/^r\$\s*[\d.,]+$/i.test(s)) return false;
    if (/^\d{2}\/\d{2}\/\d{4}/.test(s)) return false;
    if (/^[\w.+-]+@[\w.-]+$/.test(s)) return false;
    if (/^\+?\d[\d\s()-]{7,}$/.test(s)) return false;

    // frases do painel do V4
    if (/^(n[ãa]o |é |sim|parcial|existe|poss[íi]vel|confirmado|tem al[çc]ada)/i.test(s)) return false;
    if (/(n[ãa]o d[êe] lance|n[ãa]o é ag[êe]ncia|é ag[êe]ncia|n[ãa]o encontrado|n[ãa]o informado|investigar|verificar)$/i.test(s)) return false;
    return true;
  }

  // v16.2: com Cmd+A a seleção pega a página TODA — grade de ofertas, menu,
  // saldo, o próprio painel do V4. Antes de qualquer coisa, isola o bloco do
  // lead. Isso tira a obrigação de marcar campo a campo, que era onde as
  // seleções falhavam.
  function isolarBlocoDoLead(texto) {
    const t = String(texto || '');
    // o painel de detalhe começa no primeiro rótulo com dois-pontos e termina
    // em "Valor atual" / "Faça sua oferta" / "Dar lance"
    const ini = t.search(/(?:^|\n)[ \t]*Faturamento[ \t]*:/i);
    if (ini < 0) return t;                       // não achou o painel: usa tudo

    // O nome da empresa vem ANTES do primeiro rótulo. Mas com Cmd+A as linhas
    // acima podem ser do painel do V4 ou do menu do site — então sobe pegando
    // só o que parece nome de empresa, e para no primeiro lixo conhecido.
    // v19.7: se TODAS as linhas acima já são "Rótulo: valor", o texto está
    // estruturado — não há nome solto pra recuperar. Juntar as três primeiras
    // com vírgula destruía os rótulos e o parser não extraía nada.
    // Era o que recusava todo lead colado à mão.
    const antesCru = t.slice(0, ini).split('\n').map(l => l.trim()).filter(Boolean);
    const ROT = /^(empresa|nome da empresa|raz[ãa]o social|nome do respons[áa]vel|contato|cargo|e-?mail|telefone|cnpj|documento da empresa|pa[íi]s|estado|cidade|canal|urg[êe]ncia|tipo de produto|segmento|descri[çc][ãa]o|data de cria[çc][ãa]o|fase)\s*:/i;
    if (antesCru.length && antesCru.every(l => ROT.test(l))) {
      return t;                                  // já estruturado, devolve inteiro
    }

    const antes = antesCru;
    const NAO_E_NOME = /^(\+|↺|⚡|🩺|⚙|🗑|📊|📚|🔑|●|○|v4 lead analyzer|colar lead|limpar|openai|gemini|outboundpro|brasilapi|produ[çc][ãa]o|farol|depositar|ofertas|adicionar filtro|lead$|visualizado|denunciar|detalhes|ver no crm|adquirido|r\$|\d{2}:\d{2}|faturamento|segmento|tipo de|canal|valor)/i;
    const cabeca = [];
    for (let i = antes.length - 1; i >= 0 && cabeca.length < 3; i--) {
      const l = antes[i];
      if (NAO_E_NOME.test(l)) { if (cabeca.length) break; else continue; }
      cabeca.unshift(l);
    }

    let fim = t.length;
    for (const marca of [/\n[ \t]*Valor atual[ \t]*:/i, /\n[ \t]*Fa[çc]a (a )?sua oferta/i,
                         /\n[ \t]*Dar lance/i, /\n[ \t]*\+\s*COLAR LEAD/i]) {
      const m = t.slice(ini).search(marca);
      if (m > 0) fim = Math.min(fim, ini + m);
    }
    return (cabeca + '\n' + t.slice(ini, fim)).trim();
  }

  function preExtract(textoBruto) {
    const bruto = String(textoBruto || '');
    const text = isolarBlocoDoLead(bruto);
    const d = {
      cnpj: null, cnpjVisivel: false, cnpjParcial: null,
      nomeEmpresa: null, nomeContato: null, cargo: null,
      email: null, emailInfo: null, telefone: null, ddd: null,
      faturamento: null, faturamentoMin: 0, faturamentoMax: 0,
      segmento: null, canal: null, urgencia: null, tipoProduto: null,
      cidade: null, estado: null, tier: null, zona: null, regiao: null, dddDivergente: false,
      horaLead: null, isNoturno: false,
      nomeAgencia: null, sinais: [],
    };

    const cm = text.match(/(\d{2})[\.\s]?(\d{3})[\.\s]?(\d{3})[\/\s]?(\d{4})[-\s]?(\d{2})/);
    if (cm && !text.match(/\d{2}[\.\s]?\d{3}[\.\s]?\d{3}\*+/)) {
      d.cnpj = `${cm[1]}.${cm[2]}.${cm[3]}/${cm[4]}-${cm[5]}`;
      d.cnpjVisivel = true;
    }
    if (!d.cnpjVisivel) {
      const pm = text.match(/Documento\s+da\s+empresa\s*:?\s*\n?\s*([\d\.\/]+?\*+)/i)
        || text.match(/CNPJ\s*:?\s*\n?\s*([\d\.\/]+?\*+)/i)
        || text.match(/(\d{2}\.\d{3}(?:\.\d{0,3})?(?:\/\d{0,4})?)\*+/);
      if (pm) {
        const dig = pm[1].replace(/[^\d]/g, '');
        if (dig.length >= 4) d.cnpjParcial = dig;
      }
    }

    // Label ancorado no início da linha — evita casar "Empresa" dentro de
    // "Documento da empresa", "Nome" dentro de "Nome do responsável", etc.
    // v14.9: o LeadBroker tem DOIS formatos e o parser só lia um.
    //   painel de detalhe → "Faturamento:\nDe 71 mil à 100 mil"   (com dois-pontos)
    //   card da grade     → "Faturamento\nDe 71 mil à 10..."      (SEM dois-pontos)
    // Marcar o card da grade não extraía nada — nem o nome da empresa. Era a
    // causa de todos os "contato n/d".
    const ROTULOS_RE = 'faturamento|segmento|pa[íi]s|documento da empresa|nome do respons[áa]vel'
      + '|nome da empresa|raz[ãa]o social|empresa|contato|nome|cargo|e-?mail|telefone'
      + '|tipo de produto|tipo de pro\\.{0,3}|urg[êe]ncia|canal|data de cria[çc][ãa]o'
      + '|descri[çc][ãa]o|estado|cidade|uf|valor atual|lance|denunciar|visualizado|lead';

    const ex = (label) => {
      // 1) "Rótulo: valor" — painel de detalhe
      let m = text.match(new RegExp(`(?:^|\\n)[ \\t]*${label}[ \\t]*:[ \\t]*\\n?[ \\t]*([^\\n]+)`, 'i'));
      // 2) "Rótulo\nvalor" — card da grade, sem dois-pontos
      if (!m) {
        m = text.match(new RegExp(`(?:^|\\n)[ \\t]*${label}[ \\t]*\\n[ \\t]*([^\\n]+)`, 'i'));
        // a linha seguinte não pode ser outro rótulo — aí o campo está vazio
        if (m && new RegExp(`^\\s*(?:${ROTULOS_RE})\\s*:?\\s*$`, 'i').test(m[1])) m = null;
      }
      if (!m || !m[1]) return null;
      const v = m[1].trim();
      if (!v || /^[\*\-\s]+$/.test(v)) return null;
      // valor truncado pelo card da grade ("Estruturação ...") não serve
      if (/^\.{3}$|^…$/.test(v)) return null;
      return v;
    };

    d.nomeEmpresa = ex('Nome da empresa') || ex('Empresa') || ex('Raz[ãa]o social');
    // v15.2: a validação existia e NÃO era chamada — mesma regressão da v10.6,
    // agora no outro ponto. A suíte pegou.
    if (d.nomeEmpresa && !nomeEmpresaPlausivel(d.nomeEmpresa)) d.nomeEmpresa = null;
    if (!d.nomeEmpresa) {
      // v14.9: no card da grade o nome vem depois de "Lead" e "Visualizado".
      // Antes eu olhava só a PRIMEIRA linha e desistia.
      const linhas = text.split('\n').map(l => l.trim()).filter(Boolean);
      const lixo = /^(faturamento|segmento|pa[ií]s|documento|nome|e-?mail|cargo|telefone|tipo|urg|canal|data|denunciar|lead|visualizado|detalhes|valor|arrematador|ver no crm|adquirido|enriquecimento|descri[çc][ãa]o|estado|cidade|observa)/i;
      const cand = linhas.find(l => l.length > 2 && l.length < 100 && !lixo.test(l)
        && !/^r\$\s|^\d{2}:\d{2}|^\d+$/i.test(l)
        && nomeEmpresaPlausivel(l));          // v15.2: aplicar de verdade
      if (cand) d.nomeEmpresa = cand;
    }
    d.nomeContato = ex('Nome do respons[áa]vel') || ex('Respons[áa]vel') || ex('Contato') || ex('Nome');
    d.cargo = ex('Cargo');
    d.email = ex('E-?mail');
    d.faturamento = ex('Faturamento');
    d.segmento = ex('Segmento');
    d.canal = ex('Canal');
    d.urgencia = ex('Urg[êe]ncia');
    d.cidade = ex('Cidade');
    d.estado = ex('Estado') || ex('UF');
    d.tipoProduto = ex('Tipo\\s+de\\s+produto');
    // v15.0: o LeadBroker passou a mandar um bloco "Enriquecimento" com várias
    // linhas — o ex() pega só a primeira, então aqui lemos até o próximo rótulo.
    {
      const mEnr = text.match(/(?:^|\n)[ \t]*Enriquecimento[ \t]*:?[ \t]*\n?([\s\S]*?)(?=\n[ \t]*(?:Estado|Cidade|Descri[çc][ãa]o|Canal|Data de cria|Valor atual)[ \t]*:|$)/i);
      if (mEnr && mEnr[1] && mEnr[1].trim().length > 60) d.enriquecimento = mEnr[1].trim();
    }
    d.telefone = ex('Telefone');

    // v16.2: este é o LANCE ATUAL da tela, não o valor pago. O valor de compra
    // só existe no relatório de aquisições do LeadBroker, depois do arremate —
    // e lá vem com o arrematador junto. Serve como referência de preço no
    // momento da decisão, não como custo.
    {
      // busca no texto BRUTO: o isolamento corta antes do "Valor atual"
      const mv = bruto.match(/(?:Valor atual|Lance atual)\s*:?\s*\n?\s*R?\$?\s*([\d.,]+)/i);
      if (mv) {
        const v = parseValorBR(mv[1]);
        if (v > 0 && v < 100000) d.lanceNaTela = v;
      }
    }

    const dm = text.match(/Data\s+de\s+cria[çc][ãa]o\s*:?\s*\n?\s*(\d{2}\/\d{2}\/\d{4})\s+(\d{2}):(\d{2})/i);
    if (dm) { d.horaLead = parseInt(dm[2]); d.isNoturno = (d.horaLead >= 22 || d.horaLead < 7); }

    // e-mail — chave investigativa
    d.emailInfo = parseEmail(d.email);
    if (d.emailInfo.valido) {
      // completa contato se o lead não preencheu
      if (!d.nomeContato && d.emailInfo.nomeExtraido) {
        d.nomeContato = [d.emailInfo.nomeExtraido, d.emailInfo.sobrenomeExtraido].filter(Boolean).join(' ');
        d.sinais.push(`contato reconstruído do e-mail: ${d.nomeContato}`);
      } else if (d.nomeContato && d.emailInfo.sobrenomeExtraido) {
        const partes = d.nomeContato.trim().split(/\s+/).filter(p => p.length > 1);
        if (partes.length < 2) {
          d.nomeContato = `${d.nomeContato} ${d.emailInfo.sobrenomeExtraido}`;
          d.sinais.push(`sobrenome "${d.emailInfo.sobrenomeExtraido}" extraído do e-mail`);
        }
      }
      if (!d.nomeEmpresa && d.emailInfo.empresaProvavel) {
        d.nomeEmpresa = d.emailInfo.empresaProvavel;
        d.sinais.push(`empresa reconstruída do domínio: ${d.emailInfo.dominioFull}`);
      } else if (d.emailInfo.corporativo && d.emailInfo.empresaProvavel && d.nomeEmpresa) {
        const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
        if (!norm(d.nomeEmpresa).includes(norm(d.emailInfo.empresaProvavel)) &&
            !norm(d.emailInfo.empresaProvavel).includes(norm(d.nomeEmpresa))) {
          d.sinais.push(`⚠ domínio "${d.emailInfo.dominioFull}" não bate com "${d.nomeEmpresa}"`);
        }
      }
      if (!d.emailInfo.corporativo) d.sinais.push(`e-mail genérico (${d.emailInfo.dominio}) — sem domínio próprio`);
    }

    if (d.telefone) {
      const dd = d.telefone.match(/\+?55\s*\(?(\d{2})/) || d.telefone.match(/\(?(\d{2})\)?\s*9?\d{4}[-\s]?\d{4}/);
      if (dd) d.ddd = parseInt(dd[1]);
    }
    d.regiao = d.ddd ? regiaoPorDDD(d.ddd) : null;
    d.dddDivergente = false;
    if (d.regiao && !d.cidade) {
      d.sinais.push(`sem cidade no lead — DDD ${d.ddd} sugere ${d.regiao.texto} (só desempate; portabilidade permite DDD de outra praça)`);
    } else if (d.regiao && d.estado && d.estado.toUpperCase() !== d.regiao.uf) {
      d.dddDivergente = true;
      // NÃO é red flag: portabilidade mantém o número ao mudar de cidade/estado
      d.sinais.push(`DDD ${d.ddd} (${d.regiao.texto}) difere da UF declarada "${d.estado}" — normal com portabilidade, não é contradição`);
    }

    if (d.faturamento) {
      // v14.9: o card da grade TRUNCA — "De 71 mil à 10..." era lido como R$ 10,
      // jogando um lead de R$ 71k pra fora da matriz. Quando há reticências, o
      // segundo número está cortado: usa só o primeiro e marca como truncado.
      const truncado = /\.{2,}|…/.test(d.faturamento);
      let txtFat = d.faturamento;
      if (truncado) {
        txtFat = txtFat.replace(/\s*(\.{2,}|…).*$/, '');   // corta no "..."
        d.faturamentoTruncado = true;
      }

      let toks = txtFat.toLowerCase().match(/r?\$?\s*\d[\d.,]*\s*(?:milh(?:ões|ão|oes|ao)|mil|mi|k)?/gi) || [];

      // Truncado, o último número pode estar pela metade: "De 71 mil à 10..."
      // deixa "10", que não é 10 reais — é o começo de "100 mil". Se o último
      // token perdeu a unidade e algum anterior tem, descarta o último.
      if (truncado && toks.length > 1) {
        const temUnidade = t => /(milh|mil|mi|k)\s*$/i.test(t.trim());
        if (!temUnidade(toks[toks.length - 1]) && toks.slice(0, -1).some(temUnidade)) {
          toks = toks.slice(0, -1);
        }
      }

      let vals = toks.map(parseValorBR).filter(v => v > 0);
      if (vals.length === 2 && vals[0] < 1000 && vals[1] >= 1000) {
        vals[0] = vals[0] * (vals[1] >= 1000000 ? 1000000 : 1000);
      }
      if (vals.length >= 2) { d.faturamentoMin = Math.min(...vals); d.faturamentoMax = Math.max(...vals); }
      else if (vals.length === 1) {
        d.faturamentoMin = vals[0];
        // truncado tem só o piso; o teto é desconhecido
        d.faturamentoMax = truncado ? null : vals[0];
      }
      if (d.faturamentoTruncado) {
        d.sinais.push('faturamento veio truncado do card da grade — abra o lead pra ver a faixa completa');
      }
    }

    const f = d.faturamentoMin;
    if (f >= 40000000) d.tier = 'ENTERPRISE';
    else if (f >= 16100000) d.tier = 'LARGE-PLUS';
    else if (f >= 4100000) d.tier = 'LARGE';
    else if (f >= 1000000) d.tier = 'MEDIUM-PLUS';
    else if (f >= 400000) d.tier = 'MEDIUM';
    else if (f >= 100000) d.tier = 'SMALL';
    else if (f > 0) d.tier = 'TINY';

    const zv = [11,12,13,15,16,17,18,19,21,22,24,27,28,31,32,33,34,35,37,38,41,42,43,44,45,46,47,48,49,51,53,54,55,61,62,64,65,66,67];
    const za = [71,73,74,75,77,79,81,84,85,87,88,91,92,93,94,97];
    if (d.ddd) d.zona = zv.includes(d.ddd) ? 'Verde' : za.includes(d.ddd) ? 'Amarela' : 'Vermelha';

    d.nomeAgencia = detectarNomeAgencia(d.nomeEmpresa);
    if (d.nomeAgencia) d.sinais.push(`🚨 nome contém "${d.nomeAgencia.tipo}" — padrão de agência`);
    if (d.isNoturno) d.sinais.push(`lead noturno (${d.horaLead}h)`);
    if (!d.tier) d.sinais.push('faturamento não declarado');

    return d;
  }

  // ═══════════════════════════════════════════════════════════════
  // APIs
  // ═══════════════════════════════════════════════════════════════
  function callGemini(sys, user, key, timeout) {
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({
          systemInstruction: { parts: [{ text: sys }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: {
            temperature: 0,
            // v19.2: 16384 estourava o limite do gemini-2.5-flash (8192) e a
            // API rejeitava TODA chamada — foi o que deu "ERRO" nos cards.
            // Fica no teto do modelo; o raciocínio cabe dentro dele.
            maxOutputTokens: 8192,
            // ⚠️ thinkingBudget: 0 era a causa de "empresa não existe" em
            // empresa que o Google acha na primeira busca.
            //
            // No Gemini 2.5 a decisão de CHAMAR UMA FERRAMENTA acontece no
            // raciocínio. Com budget 0 o modelo responde direto, sem passar
            // pela etapa que invocaria o google_search — a ferramenta ficava
            // declarada e nunca era usada. Resultado: zero buscas em todos os
            // leads, e o modelo respondendo só com o que já sabia.
            //
            // O comentário anterior dizia que budget baixo deixava a resposta
            // vazia. Era verdade: o thinking consome do MESMO teto de saída.
            // Com 1024 sobram ~7000 tokens pra resposta, que é folgado pro JSON
            // que a análise devolve — e é o bastante pro modelo decidir buscar.
            thinkingConfig: { thinkingBudget: 1024 },
          },
          tools: [{ google_search: {} }],
        }),
        timeout,
        onload(r) {
          try {
            const d = JSON.parse(r.responseText);
            if (d.error) return rej(new Error(d.error.message || 'Gemini erro'));
            const cand = d.candidates?.[0];
            const t = (cand?.content?.parts || []).map(p => p.text).filter(Boolean).join('\n');
            if (!t) {
              const fr = cand?.finishReason || d.promptFeedback?.blockReason || 'sem conteúdo';
              return rej(new Error(`Gemini vazio (${fr})`));
            }
            // v9.32: contagem real de tokens e de buscas feitas
            const um = d.usageMetadata || {};
            const gm = cand?.groundingMetadata || {};
            const queries = (gm.webSearchQueries || []).length;
            res({
              texto: t.trim(),
              uso: {
                in: um.promptTokenCount || 0,
                out: (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0),
                // no 2.5 a cobrança é por prompt; guardo as queries pra referência
                buscas: gm.groundingChunks || queries ? 1 : 0,
                queries,
              },
            });
          } catch (e) { rej(new Error('Gemini: ' + e.message)); }
        },
        onerror() { rej(new Error('rede (Gemini)')); },
        ontimeout() { rej(new Error('timeout Gemini')); },
      });
    });
  }

  // Modelos de busca da OpenAI mudam de nome com frequência (e são descontinuados).
  // Ordem de tentativa; o primeiro que responder vence. Editável pelo painel.
  const OPENAI_SEARCH_CHAIN = [
    { api: 'responses', model: 'gpt-4o' },
    { api: 'responses', model: 'gpt-4.1' },
    { api: 'chat', model: 'gpt-4o-search-preview' },
    { api: 'chat', model: 'gpt-4o-mini-search-preview' },
    { api: 'plain', model: 'gpt-4o' },   // último recurso: sem busca web
  ];

  function getSearchChain() {
    const custom = GM_getValue('v4_openai_search_model', '');
    if (custom) return [{ api: 'responses', model: custom }, { api: 'chat', model: custom }, ...OPENAI_SEARCH_CHAIN];
    return OPENAI_SEARCH_CHAIN;
  }

  // Responses API — formato atual pra busca web
  function callResponsesAPI(sys, user, key, timeout, model) {
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.openai.com/v1/responses',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        data: JSON.stringify({
          model,
          instructions: sys,
          input: user,
          tools: [{ type: 'web_search' }],
          max_output_tokens: 4000,
        }),
        timeout,
        onload(r) {
          try {
            const d = JSON.parse(r.responseText);
            if (d.error) return rej(new Error(`[${model}] ${d.error.message}`));
            let t = d.output_text || '';
            if (!t && Array.isArray(d.output)) {
              t = d.output
                .flatMap(o => (o.content || []))
                .filter(c => c.type === 'output_text' || typeof c.text === 'string')
                .map(c => c.text).filter(Boolean).join('\n');
            }
            if (!t) return rej(new Error(`[${model}] resposta vazia`));
            const u = d.usage || {};
            res({ texto: t.trim(), uso: { in: u.input_tokens || 0, out: u.output_tokens || 0 } });
          } catch (e) { rej(new Error(`[${model}] ${e.message}`)); }
        },
        onerror() { rej(new Error(`[${model}] erro de rede`)); },
        ontimeout() { rej(new Error(`[${model}] timeout`)); },
      });
    });
  }

  // Chat Completions com web_search_options (formato legado)
  function callChatSearch(sys, user, key, timeout, model, comBusca) {
    return new Promise((res, rej) => {
      const payload = {
        model,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        max_tokens: 2000,
      };
      if (comBusca) payload.web_search_options = {};
      else payload.temperature = 0;
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.openai.com/v1/chat/completions',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        data: JSON.stringify(payload),
        timeout,
        onload(r) {
          try {
            const d = JSON.parse(r.responseText);
            if (d.error) return rej(new Error(`[${model}] ${d.error.message}`));
            const t = d.choices?.[0]?.message?.content || '';
            if (!t) return rej(new Error(`[${model}] resposta vazia`));
            const u = d.usage || {};
            res({ texto: t.trim(), uso: { in: u.prompt_tokens || 0, out: u.completion_tokens || 0 } });
          } catch (e) { rej(new Error(`[${model}] ${e.message}`)); }
        },
        onerror() { rej(new Error(`[${model}] erro de rede`)); },
        ontimeout() { rej(new Error(`[${model}] timeout`)); },
      });
    });
  }

  async function callOpenAISearch(sys, user, key, timeout) {
    const chain = getSearchChain();
    const falhas = [];
    // modelo que funcionou da última vez entra primeiro
    const ultimo = GM_getValue('v4_openai_search_ok', '');
    const ordem = ultimo
      ? [...chain.filter(c => `${c.api}:${c.model}` === ultimo), ...chain.filter(c => `${c.api}:${c.model}` !== ultimo)]
      : chain;

    for (const step of ordem) {
      try {
        let t;
        if (step.api === 'responses') t = await callResponsesAPI(sys, user, key, timeout, step.model);
        else if (step.api === 'chat') t = await callChatSearch(sys, user, key, timeout, step.model, true);
        else t = await callChatSearch(sys, user, key, timeout, step.model, false);

        GM_setValue('v4_openai_search_ok', `${step.api}:${step.model}`);
        if (step.api === 'plain') console.warn('[V4] ⚠️ rodando SEM busca web — só conhecimento do modelo');
        return t;   // {texto, uso}
      } catch (e) {
        falhas.push(e.message);
        // erro de credencial não adianta tentar outro modelo
        if (/api key|unauthorized|401|quota|insufficient_quota|billing/i.test(e.message)) break;
      }
    }
    GM_setValue('v4_openai_search_ok', '');
    throw new Error('OpenAI: ' + falhas.join(' | '));
  }

  // usado só pelo M3 (dossiê) — sem busca web
  function callOpenAI(sys, user, key, timeout) {
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.openai.com/v1/chat/completions',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        data: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
          max_tokens: 2400, temperature: 0,
        }),
        timeout,
        onload(r) {
          try {
            const d = JSON.parse(r.responseText);
            if (d.error) return rej(new Error(d.error.message));
            const t = d.choices?.[0]?.message?.content || '';
            if (!t) return rej(new Error('OpenAI vazio'));
            const u = d.usage || {};
            res({ texto: t.trim(), uso: { in: u.prompt_tokens || 0, out: u.completion_tokens || 0 } });
          } catch (e) { rej(new Error('OpenAI: ' + e.message)); }
        },
        onerror() { rej(new Error('rede (OpenAI)')); },
        ontimeout() { rej(new Error('timeout OpenAI')); },
      });
    });
  }

  function callBrasilAPI(cnpj) {
    return new Promise(res => {
      const c = String(cnpj || '').replace(/[^\d]/g, '');
      if (c.length !== 14) return res(null);
      GM_xmlhttpRequest({
        method: 'GET', url: `https://brasilapi.com.br/api/cnpj/v1/${c}`, timeout: 8000,
        onload(r) { try { res(r.status >= 400 ? null : JSON.parse(r.responseText)); } catch (e) { res(null); } },
        onerror() { res(null); }, ontimeout() { res(null); },
      });
    });
  }

  function callOutbound(endpoint, token, params = {}, method = 'GET') {
    return new Promise(res => {
      if (!token) return res(null);
      let url = `https://app.outboundpro.com.br/api${endpoint}`;
      if (method === 'GET' && Object.keys(params).length) url += '?' + new URLSearchParams(params).toString();
      GM_xmlhttpRequest({
        method, url,
        headers: { 'Token': token, 'Content-Type': 'application/json' },
        data: method !== 'GET' ? JSON.stringify(params) : undefined,
        timeout: 10000,
        onload(r) {
          try {
            if (r.status >= 400) return res(null);
            const d = JSON.parse(r.responseText);
            res(d.response === 'error' ? null : d);
          } catch (e) { res(null); }
        },
        onerror() { res(null); }, ontimeout() { res(null); },
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // CNPJ → dados oficiais + match no QSA
  // ═══════════════════════════════════════════════════════════════
  function normNome(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  }

  // v9.3: qualifica o match em vez de só dizer "achei".
  // Antes bastava 2 partes do nome coincidirem e retornava o primeiro sócio —
  // sem checar se OUTRO sócio também batia (ambiguidade) nem quão distintivo
  // era o nome. "Maria Santos" contra QSA com "Ana Maria Santos" passava como
  // match forte, quando é provavelmente outra pessoa.
  function matchQsa(qsa, nomeContato, empresa, emailInfo) {
    // v21.1: contato com nome curto ("Eduardo") não casava com o QSA, mas o
    // e-mail costuma trazer o nome completo — eduardoa.dacruz@ bate com
    // EDUARDO ANACLETO DA CRUZ. Caso EVOLUTION: sócio único, primeiro nome
    // batendo, e o box dizia "prova inválida".
    const nomeDoEmail = emailInfo
      && [emailInfo.nomeExtraido, emailInfo.sobrenomeExtraido].filter(Boolean).join(' ').trim();
    if (nomeDoEmail && Array.isArray(qsa) && qsa.length) {
      const pc = partesNome(nomeContato || '');
      const pe = partesNome(nomeDoEmail);
      // o e-mail completa um nome curto — "Eduardo" + "eduardoa.dacruz"
      if (pc.length === 1 && pe.length >= 2 && pe[0].startsWith(pc[0].slice(0, 5))) {
        // v21.1: o e-mail comprime o nome — "eduardoa.dacruz" vira
        // "Eduardoa Dacruz", que não é igual a "EDUARDO ANACLETO DA CRUZ".
        // Compara por prefixo: cada pedaço do e-mail tem que ser o começo
        // de alguma parte do nome do sócio, na ordem.
        for (const s of qsa) {
          const ps = partesNome(s.nome || '');
          if (ps.length < 2) continue;
          // v21.1: o e-mail cola as partículas — "dacruz" — e o partesNome as
          // remove do nome do sócio. Comparar sem elas dos dois lados:
          // "eduardoanacletocruz" contém "eduardo" e "cruz".
          const juntas = ps.join('');
          const semParticula = (p) => p.replace(/^(da|de|do|das|dos|e)/, '') || p;
          const bate = pe.every(p => juntas.includes(p) || juntas.includes(semParticula(p)))
                    && juntas.startsWith(pe[0].slice(0, 6));
          if (bate) {
            return {
              socio: s, confianca: qsa.length === 1 ? 'alta' : 'media',
              tipo: 'email', viaEmail: true, nomeDoEmail,
              provas: [`nome do e-mail bate com ${s.nome}`],
            };
          }
        }
      }
    }
    if (!qsa || !qsa.length || !nomeContato) return null;
    const alvo = normNome(nomeContato);
    const partesC = partesNome(nomeContato);
    if (!partesC.length) return null;

    const candidatos = [];
    for (const s of qsa) {
      const nomeS = normNome(s.nome || s.nome_socio || '');
      if (!nomeS) continue;
      const partesS = partesNome(nomeS);
      if (!partesS.length) continue;

      const comuns = partesC.filter(p => partesS.includes(p));
      const raros = comuns.filter(parteDistintiva);
      const todasPresentes = partesC.every(p => partesS.includes(p));
      const primeiroBate = partesS[0] === partesC[0];

      let tipo = null, base = '';
      if (nomeS === alvo) {
        tipo = 'exato'; base = 'nome idêntico ao do QSA';
      } else if (todasPresentes && partesC.length >= 2) {
        // "Eugenio Leite" ⊂ "Bruno Eugenio Leite da Silva"
        tipo = 'contido';
        base = `"${nomeContato}" está contido em "${s.nome || s.nome_socio}"`;
      } else if (partesC.length === 1 && todasPresentes && raros.length === 1) {
        // v9.5: só o primeiro nome, mas é RARO — "Adailson" em
        // "ADAILSON DA SILVA MOURA". A unicidade no QSA é checada depois.
        tipo = 'nome_unico';
        base = `primeiro nome "${nomeContato}" (incomum) aparece em "${s.nome || s.nome_socio}"`;
      } else if (comuns.length >= 2 && raros.length >= 1) {
        tipo = 'parcial';
        base = `${comuns.length} partes coincidem (${raros.join(', ')} é distintivo)`;
      } else if (comuns.length >= 2) {
        tipo = 'fraco';
        base = `${comuns.length} partes coincidem, todas comuns (${comuns.join(', ')})`;
      }
      if (tipo) candidatos.push({ socio: s, tipo, base, comuns, raros, primeiroBate, distintivo: raros.length > 0 });
    }
    if (!candidatos.length) return null;

    const ordem = { exato: 5, contido: 4, nome_unico: 3, parcial: 2, fraco: 1 };
    candidatos.sort((a, b) => ordem[b.tipo] - ordem[a.tipo]);
    const melhor = candidatos[0];

    // mais de um sócio no mesmo nível = ambíguo, não dá pra afirmar quem é
    const empatados = candidatos.filter(c => c.tipo === melhor.tipo);
    const ambiguo = empatados.length > 1;

    // sociedade individual / empresário individual = 1 titular só → confiança maior
    const razao = normNome(empresa && (empresa.razao_social || '') || '');
    const socioUnico = qsa.length === 1;
    const individual = /sociedade individual|empresario individual|eireli|individual de advocacia/.test(razao);

    // Confiança alta exige que ALGUMA parte do nome seja distintiva.
    // "Maria Santos" contido em "Ana Maria Santos" é só coincidência de nomes
    // comuns — mesmo sendo o único sócio, não dá pra afirmar que é a pessoa.
    let confianca;
    if (ambiguo) confianca = 'ambigua';
    else if (melhor.tipo === 'exato') confianca = (melhor.distintivo || socioUnico) ? 'alta' : 'media';
    else if (melhor.tipo === 'contido' && melhor.distintivo && (socioUnico || individual || melhor.primeiroBate)) confianca = 'alta';
    // v16.13: sócio ÚNICO + primeiro nome batendo + nome inteiro contido é forte
    // mesmo com partes comuns. Caso TOTAL HOME: "Tiago Melo" contido em
    // "TIAGO COSTA MELO", único no QSA — chance de coincidência é baixa, e o
    // box pedia confirmação de algo que a Receita já dizia.
    else if (melhor.tipo === 'contido' && (socioUnico || individual) && melhor.primeiroBate
             && partesC.length >= 2) confianca = 'alta';
    else if (melhor.tipo === 'contido' && melhor.distintivo) confianca = 'media';
    else if (melhor.tipo === 'contido') confianca = 'baixa';
    else if (melhor.tipo === 'nome_unico') confianca = 'media';
    else if (melhor.tipo === 'parcial' && socioUnico) confianca = 'media';
    else confianca = 'baixa';

    if (!melhor.distintivo) {
      melhor.base += ' — todas as partes são nomes comuns, pode ser homônimo';
    }

    const reforcos = [];
    if (socioUnico) reforcos.push('único titular no QSA');
    if (individual) reforcos.push('sociedade/empresário individual');
    if (melhor.tipo === 'nome_unico' && !ambiguo) {
      reforcos.push(`é o único "${partesC[0]}" no quadro societário`);
    }

    return {
      socio: melhor.socio,
      tipo: melhor.tipo,
      base: melhor.base,
      confianca,
      ambiguo,
      empatados: ambiguo ? empatados.map(c => c.socio.nome || c.socio.nome_socio) : null,
      reforcos,
    };
  }

  async function buscarOficial(cnpj, extracted) {
    const token = GM_getValue('v4_outbound_token', '');
    const [brasil, outbound] = await Promise.all([
      callBrasilAPI(cnpj),
      token ? callOutbound('/company/prospect', token, { cnpj: String(cnpj).replace(/[^\d]/g, '') }) : Promise.resolve(null),
    ]);

    let emp = null, fontes = [];
    if (brasil) {
      fontes.push('BrasilAPI');
      emp = {
        cnpj: brasil.cnpj,
        razao_social: brasil.razao_social,
        nome_fantasia: brasil.nome_fantasia,
        situacao: brasil.descricao_situacao_cadastral,
        capital_social: brasil.capital_social,
        porte: brasil.porte,
        abertura: brasil.data_inicio_atividade,
        cnae: `${brasil.cnae_fiscal || ''} ${brasil.cnae_fiscal_descricao || ''}`.trim(),
        // v16.0: campos que a API já devolvia e não eram lidos
        natureza: brasil.natureza_juridica || null,
        matrizFilial: brasil.identificador_matriz_filial === 2 ? 'filial' : 'matriz',
        telefones: [brasil.ddd_telefone_1, brasil.ddd_telefone_2].filter(Boolean),
        emailOficial: brasil.email || null,
        municipio: brasil.municipio || null,
        uf: brasil.uf || null,
        endereco: [brasil.logradouro, brasil.numero, brasil.municipio, brasil.uf].filter(Boolean).join(', '),
        qsa: (brasil.qsa || []).map(s => ({ nome: s.nome_socio, qualificacao: s.qualificacao_socio })),
      };
    }
    const ob = outbound && (outbound.date || outbound.data);
    if (ob) {
      fontes.push('OutboundPro');
      if (!emp) {
        emp = {
          cnpj: ob.cnpj, razao_social: ob.razao_social, nome_fantasia: ob.nome_fantasia,
          situacao: ob.situacao || ob.descricao_situacao_cadastral,
          capital_social: ob.capital_social, porte: ob.porte,
          abertura: ob.data_abertura,
          cnae: ob.cnae_principal?.descricao_subclasse || ob.cnae_fiscal_descricao || '',
          endereco: [ob.endereco, ob.endereco_cidade, ob.endereco_uf].filter(Boolean).join(', '),
          qsa: (ob.contatos || ob.qsa || []).map(s => ({ nome: s.nome || s.nome_socio, qualificacao: s.qualificacao || s.qualificacao_socio })),
        };
      }
    }
    if (!emp) return { empresa: null, fontes: [], qsaMatch: null };

    const qsaMatch = matchQsa(emp.qsa, extracted.nomeContato, emp, extracted.emailInfo);
    const parentesco = qsaMatch ? null : detectarParentesco(emp.qsa, extracted.nomeContato);
    return { empresa: emp, fontes, qsaMatch, parentesco };
  }

  // ═══════════════════════════════════════════════════════════════
  // PARENTESCO POR SOBRENOME (v8.19)
  // Contato "Eli Tavares" + QSA com "Carliene de Sousa Tavares" e
  // "Edcarlos de Souza Tavares" = provável empresa familiar. O contato não é
  // sócio registrado, mas tem altíssima chance de ser da família e ter acesso
  // ao decisor — ou ser o próprio operador do negócio.
  // ═══════════════════════════════════════════════════════════════

  // Sobrenomes muito comuns valem menos como evidência de parentesco
  const SOBRENOMES_COMUNS = new Set([
    'silva','santos','souza','sousa','oliveira','pereira','lima','carvalho',
    'ferreira','rodrigues','almeida','costa','gomes','martins','araujo','melo',
    'barbosa','ribeiro','alves','monteiro','mendes','barros','freitas','nunes',
    'marques','machado','dias','nascimento','moreira','cardoso','teixeira',
    'campos','cavalcante','cavalcanti','correia','correa','cunha','fernandes',
    'goncalves','lopes','miranda','moura','pinto','ramos','rocha','vieira',
    'castro','duarte','reis','borges','fonseca','azevedo','xavier','pires',
    'jesus','maria','junior','filho','neto','sobrinho','da','de','do','dos','das','e',
  ]);

  // Primeiros nomes muito comuns no Brasil — coincidir num deles não é evidência.
  // "Adailson" não está aqui de propósito: nome raro é sinal; "João" não é.
  const NOMES_COMUNS = new Set([
    'joao','jose','antonio','francisco','carlos','paulo','pedro','lucas','luiz','luis',
    'marcos','marcelo','rafael','bruno','felipe','gabriel','daniel','eduardo','fernando',
    'ricardo','rodrigo','andre','alexandre','thiago','tiago','leonardo','gustavo','fabio',
    'sergio','roberto','jorge','julio','mario','vitor','victor','matheus','mateus',
    'guilherme','diego','marcio','wagner','wesley','anderson','alan','adriano','cesar',
    'claudio','edson','elias','fabiano','flavio','geraldo','gilberto','henrique','igor',
    'ivan','jean','jeferson','joaquim','juliano','leandro','leonel','lucio','manoel',
    'manuel','mauricio','nelson','osvaldo','otavio','raimundo','renato','samuel','saulo',
    'sebastiao','valter','walter','vicente','wilson',
    'maria','ana','juliana','fernanda','patricia','aline','camila','amanda','bruna','carla',
    'claudia','cristina','daniela','adriana','sandra','simone','luciana','vanessa','tatiane',
    'jessica','leticia','mariana','natalia','priscila','renata','roberta','sabrina','viviane',
    'angela','beatriz','bianca','debora','elaine','gabriela','isabela','larissa','lucia',
    'marcia','monica','raquel','rosana','silvia','sonia','tania','vera','alice','laura',
    'sofia','helena','valentina','julia','manuela','isabella','luiza','lorena','livia',
    'giovanna','yasmin','rebeca','esther','elisa','marina','nicole','rafaela','catarina',
    'clara','carolina','michele','michelle','elizabete','eliane','solange','rosangela',
    'joana','teresa','terezinha','francisca','rita','regina','ligia','neusa','nair',
  ]);

  const PARTICULAS = new Set(['da','de','do','dos','das','e','del','di','van','von']);

  // Uma parte do nome é distintiva se não é sobrenome nem primeiro nome comum
  function parteDistintiva(p) {
    return !SOBRENOMES_COMUNS.has(p) && !NOMES_COMUNS.has(p);
  }

  function partesNome(n) {
    return normNome(n).split(/\s+/).filter(p => p.length > 1 && !PARTICULAS.has(p));
  }

  function detectarParentesco(qsa, nomeContato) {
    if (!qsa || !qsa.length || !nomeContato) return null;
    const partesC = partesNome(nomeContato);
    if (partesC.length < 2) return null;   // sem sobrenome não dá pra inferir

    const sobrenomesC = partesC.slice(1);  // tudo depois do primeiro nome
    const achados = [];

    for (const s of qsa) {
      const nomeS = s.nome || s.nome_socio || '';
      const partesS = partesNome(nomeS);
      if (!partesS.length) continue;

      const comuns = sobrenomesC.filter(sc => partesS.includes(sc));
      if (!comuns.length) continue;

      // primeiro nome igual → não é parentesco, é a mesma pessoa (matchQsa cuida)
      if (partesS[0] === partesC[0]) continue;

      const raros = comuns.filter(parteDistintiva);
      achados.push({
        socio: nomeS,
        qualificacao: s.qualificacao || s.qualificacao_socio || 'sócio',
        sobrenomes: comuns,
        raros,
      });
    }
    if (!achados.length) return null;

    const temRaro = achados.some(a => a.raros.length);
    const varios = achados.length >= 2;
    // sobrenome incomum, ou o mesmo sobrenome em 2+ sócios = sinal forte
    const forca = (temRaro && varios) ? 'alta' : (temRaro || varios) ? 'media' : 'baixa';

    const sobrenomesTxt = [...new Set(achados.flatMap(a => a.sobrenomes))]
      .map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(', ');

    return {
      forca,
      sobrenomes: sobrenomesTxt,
      achados,
      resumo: `sobrenome ${sobrenomesTxt} aparece no QSA (${achados.map(a => `${a.socio} — ${a.qualificacao}`).join(' · ')})`,
      nota: forca === 'alta'
        ? 'sobrenome incomum compartilhado com 2+ sócios — empresa familiar quase certa'
        : forca === 'media'
        ? 'sobrenome compartilhado com o QSA — provável empresa familiar'
        : 'sobrenome comum compartilhado — pode ser coincidência',
    };
  }

  // Primeiro nome curto pode ser apelido/redução (Eli → Elias, Eliane, Elizabete)
  function possivelApelido(nomeContato) {
    const p = partesNome(nomeContato);
    if (!p.length) return false;
    return p[0].length <= 4;
  }

  // ═══════════════════════════════════════════════════════════════
  // MOMENTO 1 — race paralelo Gemini + GPT
  // ═══════════════════════════════════════════════════════════════
  function buildLeadContext(ex) {
    const ei = ex.emailInfo || {};

    // v23.2: quando o Serper já resolveu o CNPJ, a IA não precisa procurar a
    // empresa — e era nisso que ela gastava boa parte dos 13 segundos.
    // O aviso vem ANTES de tudo: instrução no fim de prompt longo costuma
    // ser ignorada.
    const jaResolvido = ex._cnpjResolvido ? [
      '╔════════════════════════════════════════════════════════╗',
      `║ ⚡ O CNPJ JÁ ESTÁ RESOLVIDO: ${ex._cnpjResolvido}`,
      '╚════════════════════════════════════════════════════════╝',
      'A empresa JÁ foi identificada e os dados da Receita estão abaixo.',
      'NÃO busque CNPJ, razão social, endereço, porte ou data de abertura —',
      'está tudo respondido.',
      '',
      'Gaste busca só com o que a Receita não diz:',
      '  · o contato decide? (LinkedIn, site)',
      '  · o que a empresa faz HOJE? (o CNAE registrado envelhece)',
      'Duas buscas bastam.',
      '',
      '',
    ].join('\n') : '';

    return jaResolvido + `LEAD:
Empresa declarada: ${ex.nomeEmpresa || '(não preenchido)'}
Contato: ${ex.nomeContato || '(não preenchido)'}
Cargo declarado: ${ex.cargo || '?'} (não confiar)
Cidade/UF: ${ex.cidade || '?'} / ${ex.estado || '?'}${ex.regiao ? `  ← DDD ${ex.ddd} = ${ex.regiao.texto} (PISTA de desempate, não é prova: portabilidade)` : ''}${ex.dddDivergente ? '\n  ⓘ DDD e UF declarada não batem — comum por portabilidade, NÃO trate como contradição' : ''}
Faturamento declarado: ${ex.faturamento || '?'} → tier ${ex.tier || '?'}
Segmento declarado: ${ex.segmento || '?'} (pode ser o que ele QUER contratar, não o que ele É)
Canal: ${ex.canal || '?'} · Tipo de produto: ${ex.tipoProduto || '?'}
E-mail: ${ex.email || '?'}${ei.corporativo === true ? ' [DOMÍNIO CORPORATIVO — o domínio pode ser o nome real da empresa]' : ei.corporativo === false ? ' [genérico]' : ''}
${ei.sobrenomeExtraido ? `Sobrenome extraído do e-mail: ${ei.sobrenomeExtraido}` : ''}
${ex.cnpjVisivel ? `CNPJ: ${ex.cnpj}` : ex.cnpjParcial ? `CNPJ parcial: ${ex.cnpjParcial}` : 'CNPJ: não informado (normal)'}

SINAIS LOCAIS:
${ex.sinais.length ? ex.sinais.map(s => '• ' + s).join('\n') : '• nenhum'}

BUSCAS SUGERIDAS (adapte):
${ex.cnpjParcial && ex.cnpjParcial.length >= 4 ? `⚡⚡ COMECE POR AQUI — O CADASTRO TEM OS PRIMEIROS DÍGITOS DO CNPJ: ${ex.cnpjParcial}
   Busque: "${ex.nomeEmpresa || ''}" ${ex.cidade || (ex.regiao ? ex.regiao.praca : '')} ${ex.cnpjParcial}
   Econodata, Casa dos Dados e Serasa publicam o CNPJ COMPLETO como texto
   indexado — então o prefixo não serve só pra descartar: ele ENCONTRA.

   ⚡ BUSQUE DIRETO NOS AGREGADORES — eles publicam o CNPJ completo como texto
   indexado, e o Google acha na primeira tentativa:
     site:empresas.serasaexperian.com.br ${nucleoDoNome(ex.nomeEmpresa) || ex.nomeEmpresa || ''}
     site:casadosdados.com.br ${nucleoDoNome(ex.nomeEmpresa) || ex.nomeEmpresa || ''} ${ex.cnpjParcial}
     site:econodata.com.br ${nucleoDoNome(ex.nomeEmpresa) || ex.nomeEmpresa || ''}
     site:cnpj.biz ${ex.cnpjParcial}
   Caso real: "EVOLUTION ENGENHARIA E CONSTRUÇÕES" com cadastro 59.534 — a página
   da Serasa tem o nome e o CNPJ 59.534.038/0001-97 no próprio endereço, e a
   busca por nome+cidade não achava.

   TAMBÉM cruze o prefixo com o NOME DO CONTATO:
   "${ex.nomeContato || ''}" ${ex.cnpjParcial} CNPJ
   Isso resolve o caso em que o nome da empresa É o nome da pessoa — aí buscar
   pelo nome traz dezenas de homônimos e só o prefixo separa qual é a certa.

   E se você achar VÁRIAS empresas no nome do contato, confira o CNPJ de cada
   uma contra ${ex.cnpjParcial} antes de descartar todas. A certa pode estar
   na lista que você já tem.

   ⚠️ REGRA DURA: o CNPJ que você devolver TEM que começar com ${ex.cnpjParcial}.
   Achou um CNPJ que não começa assim? É OUTRA EMPRESA, mesmo com o mesmo nome,
   a mesma cidade e o mesmo CNAE. Continue procurando o candidato certo.
   Se não achar nenhum que bata, devolva empresa_existe = "nao" —
   NÃO adote o candidato errado.

` : ''}${ex.emailInfo && ex.emailInfo.corporativo ? `0. ⚡ COMECE POR AQUI: ${ex.emailInfo.dominioFull}
   O contato usa e-mail de DOMÍNIO PRÓPRIO. Isso quase sempre É o site da empresa —
   a rota mais curta para identificá-la, sem depender do nome (que pode ser
   abreviado, genérico ou homônimo). Abra ${ex.emailInfo.dominioFull} e veja:
   o que a empresa faz, razão social, CNPJ no rodapé, cidade, equipe.
   Se o site existe, a empresa EXISTE — não devolva "não encontrada".
` : ''}⚠️ NÃO busque o nome inteiro entre aspas. O nome que o lead digitou raramente
é a razão social exata — "SERJA Indústria e Comércio de Marcenaria e Estofados"
não acha nada, mas a empresa existe como "Serja Indústria de Móveis e Marcenaria".
Frase exata longa só funciona quando você JÁ sabe a razão social.

Busque pelo TERMO DISTINTIVO + o ramo + a cidade:
${nucleoDoNome(ex.nomeEmpresa) ? `1. ${nucleoDoNome(ex.nomeEmpresa)} ${ex.cidade || (ex.regiao ? ex.regiao.praca : '')} ${ex.regiao ? ex.regiao.uf : ''} CNPJ
   ← "${nucleoDoNome(ex.nomeEmpresa)}" é o que identifica esta empresa; o resto
     do nome ("indústria", "comércio", "soluções") está em milhares de outras.
2. ${nucleoDoNome(ex.nomeEmpresa)} ${ex.segmento || ''} site OR instagram` : `1. ${ex.nomeEmpresa || ''} ${ex.cidade || (ex.regiao ? ex.regiao.praca : '')}
2. ${ex.nomeEmpresa || ''} site OR instagram`}
3. ${ex.nomeEmpresa || ''} ${ex.nomeContato || ''}  ← Econodata e Casa dos Dados revelam QSA + CNPJ
4. Se nada vier: tente só o termo distintivo + CNPJ, sem cidade — a empresa pode
   estar cadastrada em outro município.`;
  }

  function extractJson(text) {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('sem JSON na resposta');
    return JSON.parse(m[0]);
  }

  // ═══════════════════════════════════════════════════════════════
  // HISTÓRICO CENTRAL (v13.0)
  // Cada análise é enviada para uma Google Sheet da unidade, identificada pelo
  // usuário. Envio é "dispara e esquece": falha de rede nunca trava a análise
  // nem aparece pro SDR — só no console.
  // A URL viaja dentro do código de configuração, então o time não configura nada.
  // ═══════════════════════════════════════════════════════════════
  function sheetUrl()  { return GM_getValue('v4_sheet_url', ''); }
  function nomeUsuario() { return GM_getValue('v4_usuario', '') || 'sem nome'; }

  function pedirNomeUsuario(forcar) {
    if (!forcar && GM_getValue('v4_usuario', '')) return GM_getValue('v4_usuario', '');
    const n = prompt(
      'Como você aparece no histórico da unidade?\n\n'
      + 'Use seu primeiro nome e a inicial do sobrenome (ex.: "Marina S.").\n'
      + 'Serve pra Re saber quem analisou cada lead.',
      GM_getValue('v4_usuario', '')
    );
    if (n && n.trim()) {
      GM_setValue('v4_usuario', n.trim().slice(0, 40));
      return n.trim();
    }
    return GM_getValue('v4_usuario', '');
  }

  function enviarParaSheet(entry, evento) {
    const url = sheetUrl();
    if (!url) return;                       // sem planilha configurada: não faz nada
    try {
      const ex = entry.extracted || {};
      const f = entry.farol || {};
      const b = entry.boxes || {};
      const of = entry.oficial || {};
      const mz = entry.matriz || {};
      const cons = lerConsumo();

      const linha = {
        evento: evento || 'analise',
        usuario: nomeUsuario(),
        versao: VERSION,
        quando: new Date().toISOString(),
        empresa: ex.nomeEmpresa || '',
        contato: ex.nomeContato || '',
        cidade: ex.cidade || (ex.regiao ? ex.regiao.praca : ''),
        uf: ex.estado || (ex.regiao ? ex.regiao.uf : ''),
        faturamento: ex.faturamento || '',
        segmento: ex.segmento || '',
        canal: ex.canal || '',
        cnpj: of.cnpj || '',
        cnae: of.cnae || '',
        ramo_real: (entry.m2 && entry.m2.ramo_real) || (entry.m1 && entry.m1.ramo_aparente) || '',
        farol: f.rot || '',
        motivo: f.motivo || '',
        box_concorrente: b.concorrente ? `${b.concorrente.cor}: ${b.concorrente.txt}` : '',
        box_empresa: b.empresa ? `${b.empresa.cor}: ${b.empresa.txt}` : '',
        box_decisor: b.decisor ? `${b.decisor.cor}: ${b.decisor.txt}` : '',
        box_margem: b.margem ? `${b.margem.cor}: ${b.margem.txt}` : '',
        margem_bucket: mz.marg ? mz.marg.bucket : '',
        margem_faixa: mz.faixa ? mz.faixa.rot : '',
        segundos: entry.elapsed || 0,
        provider: (entry.m1 && entry.m1._src) || '',
        momento2: entry.m2 ? 'sim' : 'nao',
        momento3: entry.m3 ? 'sim' : 'nao',
        resultado: entry.outcome || '',
        site: (entry.m2 && entry.m2.site) || (entry.m1 && entry.m1.site) || '',
        tokens_mes: cons ? (cons.gem.in + cons.gem.out + cons.gpt.in + cons.gpt.out) : 0,

        // v16.1: base de funil — com isto a planilha responde qual canal
        // converte, qual SDR compra melhor e se lead de madrugada presta.
        lance_na_tela: ex.lanceNaTela || '',   // ≠ valor pago (ver relatório de aquisições)
        hora_lead: ex.horaLead != null ? String(ex.horaLead).padStart(2, '0') + 'h' : '',
        lead_noturno: ex.isNoturno ? 'sim' : (ex.horaLead != null ? 'nao' : ''),
        urgencia: ex.urgencia || '',
        tipo_produto: ex.tipoProduto || '',
        tier: ex.tier || '',
        cargo_declarado: ex.cargo || '',
        natureza: (of && of.natureza) || '',
        porte_receita: (of && of.porte) || '',
        abertura: (of && of.abertura) || '',
        capital_social: (of && of.capital_social) || '',
        coerencia_porte: entry.coerenciaPorte
          ? (entry.coerenciaPorte.coerente === true ? 'confere'
            : entry.coerenciaPorte.coerente === false ? 'nao confere' : 'nao checado') : '',
        quando_comprou: entry.outcome === 'comprei' && entry.outcomeEm ? entry.outcomeEm : '',
      };

      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // evita preflight CORS
        data: JSON.stringify(linha),
        timeout: 12000,
        onload(r) { if (r.status >= 300) console.warn('[V4] sheet respondeu', r.status); },
        onerror() { console.warn('[V4] sheet: falha de rede (a análise seguiu normal)'); },
        ontimeout() { console.warn('[V4] sheet: timeout (a análise seguiu normal)'); },
      });
    } catch (e) {
      console.warn('[V4] sheet:', e.message);   // nunca propaga
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // CONSUMO (v9.32)
  // A API devolve a contagem real de tokens em usageMetadata / usage e o script
  // descartava. Sem isso o custo era estimativa: o prompt dá pra medir, mas o
  // que os resultados de busca injetam no contexto era chute.
  // Agora tudo é registrado por mês, com preço editável.
  // ═══════════════════════════════════════════════════════════════
  // Tabela vigente em 08/09/2026, informada pela Re.
  // Para atualizar: painel 📊 Consumo → digite "precos".
  const PRECO_PADRAO = {
    usd: 5.40,                        // ⚠️ dólar — CONFIRMAR, é o único valor que não veio da tabela

    // Gemini 2.5 Flash (o modelo que o script usa) · US$ por 1M tokens
    gem_in: 0.30, gem_out: 2.50,

    // OpenAI · US$ por 1M tokens. Referência GPT-5.6 Terra ($2/$12), porque o
    // gpt-4o que a cadeia de busca usa não consta na tabela de 08/09/2026.
    // Se a cadeia estiver caindo em outro modelo, ajuste aqui.
    gpt_in: 2.00, gpt_out: 12.00,

    // Grounding with Google Search
    busca_franquia: 5000,             // buscas/mês grátis (compartilhada no projeto)
    busca_mil: 14.00,                 // US$ por 1.000 após a franquia
  };

  const PRECO_FONTE = 'tabela de 08/09/2026';

  function precos() {
    try {
      const p = JSON.parse(GM_getValue('v4_precos', '') || 'null');
      return p ? { ...PRECO_PADRAO, ...p } : { ...PRECO_PADRAO };
    } catch (e) { return { ...PRECO_PADRAO }; }
  }

  function mesAtual() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function consumoVazio() {
    return { gem: { in: 0, out: 0, calls: 0, buscas: 0, queries: 0 },
             gpt: { in: 0, out: 0, calls: 0 }, leads: 0, m2: 0, m3: 0 };
  }

  function lerConsumo(mes) {
    try {
      return JSON.parse(GM_getValue('v4_uso_' + (mes || mesAtual()), '') || 'null') || consumoVazio();
    } catch (e) { return consumoVazio(); }
  }

  function registrarUso(provider, uso, momento) {
    if (!uso) return;
    const mes = mesAtual();
    const c = lerConsumo(mes);
    const p = provider === 'gemini' ? c.gem : c.gpt;
    p.in += uso.in || 0;
    p.out += uso.out || 0;
    p.calls += 1;
    if (provider === 'gemini') {
      c.gem.buscas += (uso.buscas || 0);
      c.gem.queries += (uso.queries || 0);
    }
    if (momento === 'M1') c.leads += 1;
    else if (momento === 'M2') c.m2 += 1;
    else if (momento === 'M3') c.m3 += 1;
    GM_setValue('v4_uso_' + mes, JSON.stringify(c));
  }

  function calcularCusto(c, p) {
    const gemTok = (c.gem.in / 1e6) * p.gem_in + (c.gem.out / 1e6) * p.gem_out;
    const gptTok = (c.gpt.in / 1e6) * p.gpt_in + (c.gpt.out / 1e6) * p.gpt_out;
    const cobradas = Math.max(0, c.gem.buscas - p.busca_franquia);
    const busca = (cobradas / 1000) * p.busca_mil;
    const totalUsd = gemTok + gptTok + busca;
    return { gemTok, gptTok, busca, cobradas, totalUsd, totalBrl: totalUsd * p.usd };
  }

  function mesesComUso() {
    if (typeof GM_listValues === 'undefined') return [mesAtual()];
    return GM_listValues().filter(k => k.startsWith('v4_uso_') && GM_getValue(k, ''))
      .map(k => k.replace('v4_uso_', '')).sort().reverse();
  }

  // ═══════════════════════════════════════════════════════════════
  // EXECUÇÃO SEQUENCIAL (v9.31)
  // Antes: Promise.any disparava Gemini e OpenAI juntos e usava o primeiro que
  // respondia. Rápido, mas pagava os DOIS — e o Gemini vinha ganhando 100% das
  // vezes, então a chamada da OpenAI era paga e jogada fora.
  // Agora: Gemini primeiro; OpenAI só entra se o Gemini falhar de fato.
  // Custo do momento 1 cai de ~R$ 0,19 para ~R$ 0,03 por lead.
  // ═══════════════════════════════════════════════════════════════
  function modoRace() { return GM_getValue('v4_race', '0') === '1'; }

  // callGemini/callOpenAI agora devolvem {texto, uso}; normaliza pra um formato só
  function normalizarResposta(r) {
    if (typeof r === 'string') return { texto: r, uso: null };
    return { texto: (r && r.texto) || '', uso: (r && r.uso) || null };
  }

  async function executarIA(prompt, user, timeout, tag) {
    const gk = GM_getValue('v4_gemini_key', '');
    const ok = GM_getValue('v4_openai_key', '');
    if (!gk && !ok) throw new Error('Nenhuma chave de IA configurada');

    const viaGemini = async () => {
      const { texto, uso } = normalizarResposta(await callGemini(prompt, user, gk, timeout));
      registrarUso('gemini', uso, tag);
      const j = extractJson(texto); j._src = 'gemini'; j._uso = uso; return j;
    };
    const viaOpenAI = async () => {
      const { texto, uso } = normalizarResposta(await callOpenAISearch(prompt, user, ok, timeout));
      registrarUso('gpt', uso, tag);
      const j = extractJson(texto); j._src = 'gpt'; j._uso = uso; return j;
    };

    // race opcional: paga os dois pra ganhar 2-3s. Só se ligado no painel.
    if (modoRace() && gk && ok) {
      try { return await Promise.any([viaGemini(), viaOpenAI()]); }
      catch (agg) { throw new Error((agg.errors || []).map(e => e.message).join(' · ') || 'todos falharam'); }
    }

    const erros = [];
    if (gk) {
      try { return await viaGemini(); }
      catch (e) {
        erros.push('gemini: ' + e.message);
        console.warn(`[V4] ${tag}: gemini falhou (${e.message}) — tentando OpenAI`);
      }
    }
    if (ok) {
      try { const r = await viaOpenAI(); r._fallback = !!gk; return r; }
      catch (e) { erros.push('openai: ' + e.message); }
    }
    throw new Error(erros.join(' · ') || 'nenhum provider respondeu');
  }

  function runMomento1(ex) {
    return executarIA(M1_PROMPT, buildLeadContext(ex), M1_TIMEOUT_MS, 'M1');
  }

  async function runMomento2(ex, m1) {
    const user = `${buildLeadContext(ex)}

═══ INVESTIGAÇÃO RÁPIDA (momento 1) — não fechou, aprofunde ═══
${JSON.stringify(m1, null, 2)}`;
    return executarIA(M2_PROMPT, user, M2_TIMEOUT_MS, 'M2');
  }

  async function runMomento3(entry) {
    // registra o consumo do M3 (só OpenAI, sem busca)
    const ok = GM_getValue('v4_openai_key', '');
    if (!ok) throw new Error('OpenAI necessária pro dossiê');

    let ctx = `${buildLeadContext(entry.extracted)}

═══ MOMENTO 1 ═══
${JSON.stringify(entry.m1 || {}, null, 2)}`;

    if (entry.m2) ctx += `\n\n═══ MOMENTO 2 (aprofundamento) ═══\n${JSON.stringify(entry.m2, null, 2)}`;

    if (entry.oficial) {
      const e = entry.oficial;
      ctx += `\n\n═══ DADOS OFICIAIS (${(entry.oficialFontes || []).join(' + ')}) ═══
CNPJ: ${e.cnpj || '?'}
Razão social: ${e.razao_social || '?'}
Nome fantasia: ${e.nome_fantasia || '?'}
Situação: ${e.situacao || '?'}
Abertura: ${e.abertura || '?'}
Capital social: ${e.capital_social ? 'R$ ' + Number(e.capital_social).toLocaleString('pt-BR') : '?'}
Porte: ${e.porte || '?'}
CNAE: ${e.cnae || '?'}
Endereço: ${e.endereco || '?'}
QSA: ${(e.qsa || []).map(s => `${s.nome} (${s.qualificacao})`).join(' · ') || '—'}`;
      if (entry.qsaMatch) {
        const q = entry.qsaMatch;
        ctx += `\n\n${q.confianca === 'alta' ? '✅' : '⚠️'} CONTATO BATE NO QSA (confiança ${q.confianca})
Sócio: ${q.socio.nome} — ${q.socio.qualificacao || 'sócio'}
Base do match: ${q.base}
${q.reforcos.length ? `Reforço: ${q.reforcos.join(' · ')}` : ''}
${q.ambiguo ? `⚠️ AMBÍGUO: mais de um sócio coincide (${(q.empatados || []).join(', ')}). O SDR precisa confirmar com qual está falando.` : ''}
${q.confianca === 'baixa' ? '⚠️ Match por nomes comuns — pode ser homônimo. Confirmar na ligação.' : ''}`;
      } else if (entry.parentesco) {
        ctx += `\n\n👪 PROVÁVEL VÍNCULO FAMILIAR (força ${entry.parentesco.forca})
${entry.parentesco.resumo}
${entry.parentesco.nota}
O contato NÃO é sócio registrado, mas o sobrenome coincide com o QSA. Em micro e pequena
empresa brasileira isso costuma significar: filho(a), cônjuge, irmão(ã) que opera o negócio
no dia a dia. Trate como acesso provável ao decisor, não como decisor confirmado.`;
      } else if ((e.qsa || []).length) {
        ctx += `\n\n⚠️ CONTATO NÃO APARECE NO QSA. Sócios registrados: ${(e.qsa || []).map(s => s.nome).join(', ')}.`;
      }
      if (entry.coerenciaPorte && entry.coerenciaPorte.coerente === false) {
        const cp = entry.coerenciaPorte;
        ctx += cp.severidade === 'risco_icp'
          ? `\n\n↯↯ FATURAMENTO PODE ESTAR FORA DO ICP ↯↯\n${cp.alerta}\n${cp.nota}`
          : cp.severidade === 'empresa_nova'
          ? `\n\nⓘ EMPRESA RECÉM-ABERTA (${cp.idadeMeses} meses)\n${cp.alerta}\n${cp.nota}`
          : `\n\n↯ RESSALVA DE FATURAMENTO (não bloqueante)\n${cp.alerta}\n${cp.nota}`;
      }
      if (entry.alertaCapital) ctx += `\n↯ ${entry.alertaCapital}`;
    } else {
      ctx += `\n\nDados oficiais: sem CNPJ resolvido (normal no leilão). Use a investigação web.`;
    }

    if (entry.buscaFraca) {
      ctx += `\n\n⚠️ BUSCA NÃO ESGOTADA
A investigação não achou a empresa, mas não testou: ${entry.buscaFraca.faltou}.
NÃO afirme que a empresa não existe. Muito negócio pequeno brasileiro só tem
Instagram — sem site, sem Maps, sem CNPJ visível. Instrua o SDR a pedir o
Instagram na abertura da ligação.`;
    }

    const amb = checarEmpresaIdentificada(entry.m2) || checarEmpresaIdentificada(entry.m1);
    if (amb) {
      ctx += `\n\n⚠️ EMPRESA NÃO IDENTIFICADA
${amb.motivo}. Existem empresas com esse nome, mas não se sabe qual é o lead.
NÃO trate o ramo, a margem ou o porte como conhecidos. A primeira tarefa do SDR
é descobrir de qual empresa se trata.`;
    }

    const ci = checarConcorrenteSemIdentificacao(entry.m2) || checarConcorrenteSemIdentificacao(entry.m1);
    if (ci) {
      ctx += `\n\n⚠️ CLASSIFICAÇÃO DE CONCORRENTE INVÁLIDA
${ci.motivo}
NÃO afirme no dossiê que o lead é concorrente. Diga que o ramo não pôde ser
determinado e que o SDR precisa confirmar na abertura da ligação.`;
    }

    const evR = checarEvidenciaDecisor(entry.m2) || checarEvidenciaDecisor(entry.m1);
    if (evR) {
      ctx += `\n\n⚠️ EVIDÊNCIA DE CARGO INVÁLIDA
${evR.texto}
Trate o papel do contato como NÃO COMPROVADO no dossiê, independente do que
a investigação afirmou. O SDR precisa mapear quem decide.`;
    }

    if (entry.divSegmento && entry.divSegmento.divergente) {
      ctx += `\n\nⓘ SEGMENTO DECLARADO DIVERGE DO RAMO REAL
Formulário: "${entry.divSegmento.declarado}"  ·  Investigação: "${entry.divSegmento.real}"
Não é mentira necessariamente — o campo costuma ser preenchido com o serviço que o cliente
QUER contratar, ou de forma descuidada. Mas indica cadastro pouco confiável: confirme
faturamento e ramo antes de dimensionar a proposta.`;
    }
    if (entry.emailPorte && entry.emailPorte.nivel !== 'baixo') {
      ctx += `\n\nⓘ E-MAIL vs PORTE: ${entry.emailPorte.texto}`;
    }

    // v11.4: o contexto manda o veredito da matriz, não o cálculo antigo
    const mz = entry.matriz;
    if (mz) {
      ctx += `\n\n═══ MARGEM × PORTE ═══
Faturamento declarado: ${entry.extracted.faturamento || '?'}
Classificação: ${mz.marg ? `${mz.marg.rot} margem (${mz.marg.faixa}) · ${mz.marg.nome}` : 'não classificada'}
Faixa: ${mz.faixa ? mz.faixa.rot : 'não determinada'}
Veredito: ${mz.cor === 'verde' ? 'o porte SUSTENTA o investimento' : mz.cor === 'vermelho' ? 'o porte NÃO sustenta o investimento' : 'avaliar'}
Motivo: ${mz.motivo}
Fonte do ramo: ${entry.ramoFonte === 'CNAE' ? 'CNAE da Receita (oficial)' : 'investigação — confirmar na ligação'}`;
    }
    // v17.9: o dossiê é gerado A PARTIR do que os boxes concluíram. Se o
    // contexto não manda o veredito completo, a IA reinventa — foi o que
    // produziu "margem 5-15%" e "confiança baixa" depois das correções.
    const bx = entry.boxes;
    const fr = entry.farol;
    if (bx) {
      const ic = (c) => c === 'verde' ? '✅' : c === 'vermelho' ? '❌' : c === 'concorrente' ? '🚨' : '⚠️';
      ctx += `\n\n═══ VEREDITO DO CARD (use exatamente isto) ═══
FAROL: ${fr ? fr.rot : '?'}${fr && fr.motivo ? ` — ${fr.motivo}` : ''}
${ic(bx.concorrente.cor)} Concorrente: ${bx.concorrente.txt}${bx.concorrente.sub ? ` · ${bx.concorrente.sub}` : ''}
${ic(bx.empresa.cor)} Empresa: ${bx.empresa.txt}${bx.empresa.sub ? ` · ${bx.empresa.sub}` : ''}
${ic(bx.decisor.cor)} Decisor: ${bx.decisor.txt}${bx.decisor.sub ? ` · ${bx.decisor.sub}` : ''}
${ic(bx.margem.cor)} Margem: ${bx.margem.txt}${bx.margem.sub ? ` · ${bx.margem.sub}` : ''}

⚠️ Este é o veredito final. NÃO recalcule, NÃO contradiga, NÃO invente
percentual de margem nem estimativa de lucro.`;
    }

    // v20.0: o prefixo do CNPJ é o melhor indício que o lead traz, e o dossiê
    // não recebia. Sem ele o closer não sabe que a identidade está em aberto.
    const px = entry.extracted.cnpjParcial;
    if (px && px.length >= 4) {
      ctx += `\n\nCNPJ DO CADASTRO: começa com ${fmtPrefixo(px)}`;
      if (entry.cnpjErrado) {
        ctx += `\n→ ⚠️ a investigação achou ${fmtCnpj(String(entry.cnpjErrado).replace(/\D/g, '')) || 'outro CNPJ'}`
          + `, que NÃO bate. Os dados da Receita foram descartados — a empresa`
          + ` do card ainda não foi identificada com segurança.`;
      } else if (entry.cnpjConfirmado) {
        ctx += ` — confere com o CNPJ achado. Identidade confirmada.`;
      } else if (!entry.oficial) {
        ctx += `\n→ a investigação não achou nenhum CNPJ que comece assim.`
          + ` Confirmar o CNPJ na abertura da ligação resolve o lead inteiro.`;
      }
    }

    // corte de ICP do bucket — o número que orienta o roteamento de pilar
    if (entry.matriz && entry.matriz.marg) {
      const c = corteICP(entry.matriz.marg.bucket);
      if (c) ctx += `\n\nCORTE DE ICP: margem ${entry.matriz.marg.rot} sustenta EXECUTAR a partir de ${c.texto}/mês.`;
    }

    // sinais de porte maior que o declarado — muda a decisão de lance e de pilar
    if (entry.porteMaior) {
      ctx += `\n\n═══ SINAIS DE PORTE MAIOR QUE O DECLARADO ═══
${entry.porteMaior.sinais.map(s => `• ${s}`).join('\n')}
Declarado: ${entry.porteMaior.declarado || entry.porteMaior.faixaAtual}
→ Confirmar o faturamento real é a PRIMEIRA tarefa do SDR. O roteamento de pilar
  pode mudar depois disso — não feche a porta do EXECUTAR.`;
    }

    // natureza jurídica: em empresário individual o titular É o dono
    if (entry.natureza && entry.natureza.texto) {
      ctx += `\n\nNATUREZA JURÍDICA: ${entry.natureza.texto}`;
      if (entry.natureza.individual && entry.natureza.contatoEhDono) {
        ctx += ` — a razão social é o nome do contato, então ele É o titular.`;
      }
      if (entry.natureza.filial) ctx += ` — é FILIAL, a matriz é outra.`;
    }

    // CNAE registrado vs atividade na razão social
    if (entry.cnaeVsRazao) {
      ctx += `\n\nCNAE × RAZÃO SOCIAL: o CNAE registra "${entry.cnaeVsRazao.cnae}", mas a razão`
        + ` social cita ${entry.cnaeVsRazao.extras.join(', ')}. A empresa faz mais de uma coisa —`
        + ` diga as duas no dossiê.`;
    }

    // enriquecimento do LeadBroker, quando veio
    if (entry.enriq) {
      const v = x => x === true ? 'sim' : x === false ? 'não' : 'sem info';
      ctx += `\n\nENRIQUECIMENTO DO LEADBROKER: empresa ${v(entry.enriq.empresaConfirmada)}`
        + ` · decisor ${v(entry.enriq.decisorConfirmado)} · sócio ${v(entry.enriq.socioEncontrado)}`
        + ` (${entry.enriq.negativas}/${entry.enriq.secoes.length} seções sem confirmação)`;
      if (entry.enriq.hipotetico) ctx += ' — texto majoritariamente hipotético, trate com reserva.';
    }

    const { texto, uso } = normalizarResposta(await callOpenAI(M3_PROMPT, ctx, ok, M3_TIMEOUT_MS));
    registrarUso('gpt', uso, 'M3');
    return texto;
  }

  // ═══════════════════════════════════════════════════════════════
  // FILA
  // ═══════════════════════════════════════════════════════════════
  function piscarCard(el) {
    el.style.transition = 'box-shadow .25s';
    el.style.boxShadow = '0 0 0 3px rgba(250,204,21,.55)';
    setTimeout(() => { el.style.boxShadow = ''; }, 1400);
  }

  // v8.16: lead já analisado — mostra o resultado salvo em vez de gastar API de novo
  function avisarJaAnalisado(texto, antes) {
    const h = hashLead(texto);

    // já tem card na tela? só destaca
    const existente = queue.find(q => hashLead(q.rawText) === h);
    if (existente && existente.card) {
      existente.card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      piscarCard(existente.card);
      marcarDeHistorico(existente, antes.quando, {
        empresa: (antes.dados && antes.dados.extracted && antes.dados.extracted.nomeEmpresa) || null,
        contato: (antes.dados && antes.dados.extracted && antes.dados.extracted.nomeContato) || null,
        via: antes.exato ? 'exato' : (antes.via || 'parecido'),
      });
      return;
    }

    // recria a partir do cache, sem chamar API
    const entry = addLead(antes.dados.rawText || texto);
    if (entry) {
      marcarDeHistorico(entry, antes.quando, {
        empresa: (antes.dados && antes.dados.extracted && antes.dados.extracted.nomeEmpresa) || null,
        contato: (antes.dados && antes.dados.extracted && antes.dados.extracted.nomeContato) || null,
        via: antes.exato ? 'exato' : (antes.via || 'parecido'),
      });
      entry.card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      piscarCard(entry.card);
    }
  }

  // v8.20: seleção diferente do MESMO lead — avisa e oferece reanálise se
  // a nova seleção tiver campos que a primeira não tinha
  function avisarMesmoLead(entry, novoTexto) {
    const card = entry.card;
    if (card.querySelector('.v4-mesmo-lead')) return;
    const antigo = entry.extracted || {};
    let novo;
    try { novo = preExtract(novoTexto); } catch (e) { return; }

    const campos = [
      ['nomeContato', 'contato'], ['faturamento', 'faturamento'],
      ['email', 'e-mail'], ['telefone', 'telefone'],
      ['cidade', 'cidade'], ['segmento', 'segmento'], ['canal', 'canal'],
    ];
    const ganhos = campos.filter(([k]) => !antigo[k] && novo[k]).map(([, l]) => l);

    const html = ganhos.length ? `
      <div class="v4-mesmo-lead" style="margin:0 16px 10px;padding:9px 12px;border-radius:6px;
           background:rgba(59,130,246,.10);border:1px solid rgba(59,130,246,.35)">
        <div style="font-size:11px;font-weight:800;color:#BFDBFE;letter-spacing:.5px;text-transform:uppercase">
          ↺ Mesmo lead, seleção mais completa
        </div>
        <div style="font-size:11px;color:#DBEAFE;line-height:1.5;margin-top:4px">
          A nova seleção traz <b>${esc(ganhos.join(', '))}</b> que faltava(m) na análise atual.
        </div>
        <button class="v4-act" data-refazer="1" style="margin-top:8px;border-color:#3B82F650;color:#93C5FD">
          ↻ Refazer com os dados completos
        </button>
      </div>` : `
      <div class="v4-mesmo-lead" style="margin:0 16px 10px;padding:9px 12px;border-radius:6px;
           background:rgba(120,120,120,.10);border:1px solid rgba(120,120,120,.3)">
        <div style="font-size:11px;color:#AAA;line-height:1.5">
          ↺ Esse lead já está na fila — seleção diferente, mesma empresa. Nada de novo pra analisar.
        </div>
      </div>`;

    const head = card.querySelector('.v4-card-head');
    if (head) head.insertAdjacentHTML('afterend', html);
    setTimeout(() => { const b = card.querySelector('.v4-mesmo-lead'); if (b && !ganhos.length) b.remove(); }, 8000);

    const btn = card.querySelector('[data-refazer]');
    if (btn) btn.addEventListener('click', async () => {
      GM_setValue(hashLead(entry.rawText), '');
      const i = queue.indexOf(entry);
      if (i >= 0) queue.splice(i, 1);
      if (card.parentNode) card.parentNode.removeChild(card);
      updateCount();
      const ok = await prepararAnalise();
      if (ok) addLead(novoTexto);
    });
  }

  // v18.8: refaz do zero, ignorando o cache. Antes só existia no aviso de
  // "lead já analisado" — e esse aviso não aparecia quando o cache batia exato,
  // então não havia como forçar uma consulta nova.
  async function refazerAnalise(entry) {
    if (!confirm('Refazer a análise do zero?\n\nO resultado salvo será substituído e as APIs serão consultadas de novo.')) return;
    const texto = entry.rawText;
    try { GM_setValue(hashLead(texto), ''); } catch (e) {}
    const i = queue.indexOf(entry);
    if (i >= 0) queue.splice(i, 1);
    if (entry.card && entry.card.parentNode) entry.card.parentNode.removeChild(entry.card);
    updateCount();
    renderRail();
    const ok = await prepararAnalise();
    if (ok) addLead(texto);
  }

  function marcarDeHistorico(entry, quando, casou) {
    const card = entry.card;
    if (card.querySelector('.v4-de-hist')) return;
    const outcome = entry.outcome
      ? ` · você marcou como <b>${entry.outcome === 'comprei' ? 'arrematado' : entry.outcome === 'cliente' ? 'virou cliente' : 'passado'}</b>`
      : '';
    const html = `
      <div class="v4-de-hist" style="margin:0 16px 10px;padding:9px 12px;border-radius:6px;
           background:rgba(250,204,21,.10);border:1px solid rgba(250,204,21,.35)">
        <div style="font-size:11px;font-weight:800;color:#FDE68A;letter-spacing:.5px;text-transform:uppercase">
          ↺ Lead já analisado
        </div>
        <div style="font-size:11px;color:#FEF3C7;line-height:1.5;margin-top:4px">
          ${casou && casou.empresa && casou.via !== 'exato'
            ? `Casou com <b>${esc(casou.empresa)}</b>${casou.contato ? ` (${esc(casou.contato)})` : ''}, analisado ${esc(quandoTexto(quando))}${outcome}.<br>
               <span style="color:#FCD34D">⚠️ Se não é o mesmo lead, clique em Analisar de novo.</span>`
            : `Analisado ${esc(quandoTexto(quando))}${outcome}. Resultado abaixo veio do histórico — nenhuma API foi consultada.`}
        </div>
        <button class="v4-act" data-reanalisar="1" style="margin-top:8px;border-color:#FACC1550;color:#FACC15">
          ↻ Analisar de novo (gasta API)
        </button>
      </div>`;
    const head = card.querySelector('.v4-card-head');
    if (head) head.insertAdjacentHTML('afterend', html);

    const btn = card.querySelector('[data-reanalisar]');
    if (btn) btn.addEventListener('click', async () => {
      if (!confirm('Refazer a análise do zero?\n\nO resultado salvo será substituído e uma nova consulta será feita nas APIs.')) return;
      const texto = entry.rawText;
      GM_setValue(hashLead(texto), '');
      const i = queue.indexOf(entry);
      if (i >= 0) queue.splice(i, 1);
      if (entry.card && entry.card.parentNode) entry.card.parentNode.removeChild(entry.card);
      updateCount();
      const ok = await prepararAnalise();
      if (ok) addLead(texto);
    });
  }

  // v19.4: quando o lead é colado num campo de texto simples, as quebras de
  // linha se perdem e tudo vira uma linha só. O parser lê "Rótulo: valor" por
  // linha, então só enxergava o primeiro campo — foi o que deu "serja" como
  // nome da empresa e nada mais.
  // Aqui a gente devolve as quebras, cortando antes de cada rótulo conhecido.
  const ROTULOS_COLAGEM = [
    // ⚠️ nada de rótulo que seja SUFIXO de outro: "Responsável" casaria dentro
    // de "Nome do responsável" e cortaria a linha no meio. O texto do LeadBroker
    // usa sempre a forma longa.
    'Empresa', 'Nome da empresa', 'Nome do responsável', 'Contato',
    'Cargo', 'Faturamento', 'Segmento', 'Tipo de produto', 'Tipo produto',
    'Canal', 'Urgência', 'E-mail', 'Email', 'Telefone', 'CNPJ', 'País', 'Pais',
    'Estado', 'Cidade', 'Descrição', 'Descricao', 'Documento da empresa',
    'Data de criação', 'Data de criacao', 'Valor lance', 'Valor inicial',
    'Valor atual', 'Enriquecimento', 'Fase', 'Observações',
  ];

  function reporQuebras(texto) {
    const t = String(texto || '');
    if (t.split(/\r?\n/).filter(l => l.trim()).length >= 4) return t;   // já tem quebras

    // Acha as posições de TODOS os rótulos, do mais longo para o mais curto,
    // e descarta os que começam dentro de outro já marcado. Sem isso,
    // "Empresa:" corta no meio de "Nome da empresa:".
    const ordenados = [...ROTULOS_COLAGEM].sort((a, b) => b.length - a.length);
    const marcas = [];
    for (const rot of ordenados) {
      const re = new RegExp(rot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:', 'gi');
      let m;
      while ((m = re.exec(t)) !== null) {
        const ini = m.index, fim = m.index + m[0].length;
        const dentroDeOutro = marcas.some(x => ini >= x.ini && ini < x.fim);
        if (!dentroDeOutro) marcas.push({ ini, fim });
      }
    }
    if (marcas.length < 2) return t;      // não parece lead rotulado

    marcas.sort((a, b) => a.ini - b.ini);
    const partes = [];
    for (let i = 0; i < marcas.length; i++) {
      const de = marcas[i].ini;
      const ate = i + 1 < marcas.length ? marcas[i + 1].ini : t.length;
      const p = t.slice(de, ate).trim();
      if (p) partes.push(p);
    }
    // o que vier ANTES do primeiro rótulo também conta (nome solto no topo)
    const antes = t.slice(0, marcas[0].ini).trim();
    return (antes ? [antes, ...partes] : partes).join('\n');
  }

  function addLead(rawTextOriginal) {
    const rawText = reporQuebras(rawTextOriginal);
    liberar(rawText);   // entrou na fila, não precisa mais da reserva
    const extracted = preExtract(rawText);

    // v8.21: sem empresa, sem contato, sem e-mail e sem CNPJ não há o que investigar
    const temAncora = extracted.nomeEmpresa || extracted.nomeContato
                   || (extracted.email && !/\*{2,}/.test(extracted.email))
                   || extracted.cnpjVisivel || extracted.cnpjParcial;
    if (!temAncora) {
      openPanel();
      alert('Não consegui identificar empresa, contato nem e-mail nessa seleção.\n\n'
          + 'Marque o bloco completo do lead na página do LeadBroker.');
      return null;
    }
    const id = ++queueId;
    const cached = getCached(rawText);
    // v18.8: o aviso "lead já analisado" só aparecia no caminho que casa por
    // identidade. Quando o cache batia exato, o resultado vinha sem aviso e sem
    // botão de refazer — e não havia como forçar uma análise nova.
    const veioDoCache = !!(cached && cached.m1);
    const card = createCard(id, extracted);

    const entry = {
      id, rawText, extracted, card,
      identidade: chaveIdentidade(rawText),
      m1: cached?.m1 || null,
      m2: cached?.m2 || null,
      m3: cached?.m3 || null,
      oficial: cached?.oficial || null,
      oficialFontes: [],
      qsaMatch: cached?.qsaMatch || null,
      parentesco: cached?.parentesco || null,
      coerenciaPorte: cached?.coerenciaPorte || null,
      alertaCapital: cached?.alertaCapital || null,
      cnpjResolvido: cached?.cnpjResolvido || null,
      matriz: cached?.matriz || null,
      sub: cached?.sub || null,
      outcome: cached?.outcome || null,
      elapsed: 0, timer: null,
      state: cached ? 'cached' : 'pending',
    };
    if (veioDoCache) {
      entry.deCache = true;
      entry.cacheEm = cached.timestamp;
      setTimeout(() => { try { marcarDeHistorico(entry, cached.timestamp, null); } catch (e) {} }, 60);
    }
    queue.push(entry);

    const empty = document.getElementById('v4-empty');
    if (empty) empty.style.display = 'none';
    bodyEl.insertBefore(card, bodyEl.firstChild);
    updateCount();   // v9.18: não seleciona — a visão de produção mostra o andamento

    // Atalho local: nome é padrão de agência → alerta imediato (não bloqueia a IA)
    if (extracted.nomeAgencia) markLocalAgencySuspicion(entry);

    if (cached && cached.m1) {
      entry.state = 'done';
      entry.doCache = true;
      computeFit(entry);
      renderM1(entry);
      if (entry.oficial) applyOficial(entry);
      if (entry.m2) {
        renderM2(entry);
        mergeM2IntoChecks(entry);
        renderBoxes(entry);
        renderCoerenciaCadastro(entry);
      }
      if (entry.m3) renderM3(entry);
      renderActions(entry);
      updateCount();
    } else {
      startM1(entry);
    }
    return entry;
  }

  function markLocalAgencySuspicion(entry) {
    const t = entry.card.querySelector('.v4-card-title');
    if (t && !t.querySelector('.v4-badge-concorrente')) {
      t.insertAdjacentHTML('beforeend', `<span class="v4-badge-concorrente" title="Nome bate padrão de agência — validando">⚠ nome de agência</span>`);
    }
  }

  // v14.6: seleção pobre não vale uma chamada de IA. Sem nome de contato, sem
  // e-mail e sem faturamento, a análise não tem o que investigar — e o card sai
  // com três boxes pendentes, como aconteceu no "Plotagens e Cia".
  function selecaoPobre(ex) {
    const temPessoa = !!(ex.nomeContato || ex.email || ex.telefone);
    const temPorte = !!ex.faturamentoMin;
    if (temPessoa && temPorte) return null;
    const falta = [];
    if (!temPessoa) falta.push('nome do responsável, e-mail ou telefone');
    if (!temPorte) falta.push('faturamento');
    return { falta, texto: 'A seleção não trouxe ' + falta.join(' nem ') };
  }

  async function startM1(entry) {
    if (processing >= MAX_PARALLEL) { setTimeout(() => startM1(entry), 300); return; }
    processing++;
    entry.state = 'running';
    const lbl = entry.card.querySelector('.v4-card-status-label');
    if (lbl) { lbl.textContent = 'analisando'; lbl.style.color = '#888'; }
    const t0 = Date.now();
    entry.timer = setInterval(() => {
      entry.elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const el = entry.card.querySelector('.v4-verdict-time');
      if (el) el.textContent = entry.elapsed + 's';
    }, 100);
    updateCount();

    // CNPJ já visível? dispara oficial em paralelo desde já
    let oficialPromise = null;
    if (entry.extracted.cnpjVisivel && entry.extracted.cnpj) {
      oficialPromise = buscarOficial(entry.extracted.cnpj, entry.extracted);
    }

    try {
      // v21.0: a busca crua roda EM PARALELO com a IA. Ela costuma terminar em
      // ~1s, então o CNPJ já está resolvido quando o M1 voltar — e a BrasilAPI
      // pode ser chamada sem esperar a IA descobrir o número.
      const buscaCrua = acharCnpjPorBusca(entry.extracted)
        .then(r => {
          if (r && r.cnpj) {
            entry.cnpjPorBusca = r;
            console.log('[V4] CNPJ achado pela busca crua em', r.ms + 'ms:', fmtCnpj(r.cnpj), '·', r.query);

            // v23.5: só avisa a IA que está resolvido quando há PROVA. Sem ela,
            // o aviso manda parar de procurar com o número errado na mão —
            // pior que não avisar. Caso INSTITUTO PRESBITERIANO: a busca trouxe
            // 07.293.861 e a empresa era 28.153.459.
            const provado = r.casaPrefixo || (r.citaNome && !r.nomeGenerico);
            if (provado && entry.extracted) {
              entry.extracted._cnpjResolvido = fmtCnpj(r.cnpj);
            } else {
              console.log('[V4] sem prova de que é a empresa certa — a IA vai procurar');
            }
          }
          return r;
        })
        .catch(() => null);

      const m1 = await runMomento1(entry.extracted);
      // v18.7: guardar quantas buscas o grounding fez neste lead. "Gemini ON"
      // só diz que a chave responde; isto diz se a busca aconteceu mesmo.
      if (m1 && m1._uso && typeof m1._uso.queries === 'number') entry.queriesM1 = m1._uso.queries;
      entry.m1 = m1;
      entry.elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const l2 = entry.card.querySelector('.v4-card-status-label');
      if (l2) l2.remove();
      computeFit(entry);
      renderM1(entry);
      renderActions(entry);

      // CNPJ descoberto pela IA → busca oficial
      const cnpjIA = m1.cnpj_descoberto && String(m1.cnpj_descoberto).replace(/[^\d]/g, '');
      if (!oficialPromise && cnpjIA && cnpjIA.length === 14) {
        entry.extracted.cnpj = m1.cnpj_descoberto;
        oficialPromise = buscarOficial(cnpjIA, entry.extracted);
      }

      if (oficialPromise) {
        oficialPromise.then(r => {
          if (!r || !r.empresa) return;
          // v18.0: o CNPJ achado tem que bater com o prefixo do cadastro
          const conf = confrontarCnpj(r.empresa.cnpj, entry.extracted.cnpjParcial);
          if (conf && !conf.bate) {
            entry.cnpjErrado = conf;
            console.warn('[V4] CNPJ descartado:', conf.texto);
            try { renderBoxes(entry); } catch (e) {}
            return;                                   // não adota a empresa errada
          }
          entry.cnpjConfirmado = conf && conf.bate ? conf : null;
          entry.oficial = r.empresa;
          entry.oficialFontes = r.fontes;
          entry.qsaMatch = r.qsaMatch;
          entry.cnpjResolvido = r.empresa.cnpj;
          applyOficial(entry);
          saveEntry(entry);
        }).catch(() => { });
      }

      entry.state = 'done';
      saveEntry(entry);
    } catch (e) {
      entry.state = 'error';
      entry.error = e.message;
      renderError(entry);
    } finally {
      if (entry.timer) { clearInterval(entry.timer); entry.timer = null; }
      processing--;
      updateCount();
    }
  }

  // v11.4: o cálculo de endereçável saiu; a matriz é aplicada em boxMargem.
  // O que continua aqui são as checagens de coerência do cadastro, que a v9.37
  // já fazia e não têm relação com o cálculo removido.
  function computeFit(entry) {
    const ex = entry.extracted;
    const ramo = (entry.m2 && entry.m2.ramo_real) || (entry.m1 && entry.m1.ramo_aparente) || null;
    entry.divSegmento = compararSegmento(ramo, ex.segmento);
    entry.emailPorte = checarEmailPorte(ex.emailInfo, ex.faturamentoMin);
    entry.iniciais = checarIniciais(ex.nomeEmpresa, ex.nomeContato);
    entry.enriq = lerEnriquecimento(ex.enriquecimento);
    return entry;
  }

  function updateFabCount() {
    const total = queue.length;
    const run = queue.filter(q => q.state === 'running' || q.state === 'pending').length;
    let el = document.getElementById('v4-fab-count');
    if (!total) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('span');
      el.id = 'v4-fab-count';
      fab.appendChild(el);
    }
    el.textContent = run ? `${total}·${run}⟳` : String(total);
    el.title = run ? `${total} leads · ${run} em andamento` : `${total} leads analisados — clique pra ver`;
  }

  function updateCount() {
    updateFabCount();
    atualizarRotuloFab();
    renderRail();
    renderProducao();
    const total = queue.length;
    if (!total) {
      queueCount.style.display = 'none';
      const e = document.getElementById('v4-empty');
      if (e) e.style.display = 'block';
      return;
    }
    queueCount.style.display = 'inline-block';
    const run = queue.filter(q => q.state === 'running').length;
    const wait = queue.filter(q => q.state === 'pending').length;
    const done = queue.filter(q => q.state === 'done' || q.state === 'error').length;
    const partes = [`${done}/${total}`];
    if (run) partes.push(`${run} rodando`);
    if (wait) partes.push(`${wait} na fila`);
    queueCount.textContent = partes.join(' · ');
    queueCount.title = `${total} leads · ${done} prontos · ${run} analisando · ${wait} aguardando (máx ${MAX_PARALLEL} em paralelo)`;

    // atualiza a posição de quem está esperando
    let pos = 0;
    queue.forEach(q => {
      if (q.state !== 'pending') return;
      pos++;
      const lbl = q.card.querySelector('.v4-card-status-label');
      if (lbl) lbl.textContent = `${pos}º na fila`;
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════
  function createCard(id, ex) {
    const el = document.createElement('div');
    el.className = 'v4-card processing';
    el.id = `v4c-${id}`;
    const meta = [
      ex.nomeContato || 'contato n/d',
      ex.cidade ? `${ex.cidade}/${ex.estado || ''}` : null,
      ex.tier ? `Tier ${ex.tier}` : null,
      ex.canal,
    ].filter(Boolean).join(' · ');

    el.innerHTML = `
      <div class="v4-card-head">
        <div class="v4-card-num">#${id}</div>
        <div class="v4-card-titlewrap">
          <div class="v4-card-title"><span>${esc(ex.nomeEmpresa || 'Empresa não identificada')}</span></div>
          <div class="v4-card-meta">${esc(meta)}</div>
        </div>
        <div class="v4-card-verdict">
          <div class="v4-farol" style="border-color:#2A2A2A;background:rgba(255,255,255,.02)">
            <div class="v4-farol-luz"><span class="v4-spinner" style="width:20px;height:20px;border-width:3px"></span></div>
            <div class="v4-farol-txt v4-card-status-label" style="color:#777">aguardando</div>
          </div>
          <div class="v4-farol-sub v4-verdict-time">0s</div>
        </div>
      </div>
      <div class="v4-portemaior" style="display:none"></div>
      <div class="v4-boxes"></div>
      <div class="v4-dadoswrap"></div>
      <div class="v4-checks">
        <div class="v4-check pending"><div class="v4-check-icon">⏳</div><div class="v4-check-body">
          <div class="v4-check-label">Concorrente</div><div class="v4-check-detail">investigando…</div></div></div>
        <div class="v4-check pending"><div class="v4-check-icon">⏳</div><div class="v4-check-body">
          <div class="v4-check-label">Empresa existe</div><div class="v4-check-detail">investigando…</div></div></div>
        <div class="v4-check pending"><div class="v4-check-icon">⏳</div><div class="v4-check-body">
          <div class="v4-check-label">Decisor</div><div class="v4-check-detail">investigando…</div></div></div>
      </div>
      <div class="v4-tags"></div>
      <div class="v4-fitwrap"></div>
      <div class="v4-flagswrap"></div>
      <div class="v4-m2wrap"></div>
      <div class="v4-m3wrap"></div>
      <div class="v4-actions"></div>
    `;
    return el;
  }

  // v9.8: farol de decisão. Antes era um emoji de 22px no canto — pouco visível
  // sob pressão de tempo, que é justamente quando ele precisa ser lido.
  const FAROL = {
    verde:      { luz: '🟢', txt: 'GO' },
    amarelo:    { luz: '🟡', txt: 'CAUTION' },
    vermelho:   { luz: '🔴', txt: 'STOP' },
    concorrente:{ luz: '🚨', txt: 'CONCORRENTE' },
  };

  // recalcula a cor a partir do estado atual e repinta o farol
  // v18.3: a trilha era atualizada por setTimeout (assíncrono, sempre roda) e o
  // card logo depois, de forma síncrona. Qualquer falha no meio deixava a trilha
  // com o valor novo e o card com o antigo — trilha CAUTION, card GO.
  // Agora o card vem primeiro e cada etapa é isolada: uma falha não contamina
  // as outras.
  function repintarFarol(entry, novaCor, isConcorrente) {
    const card = entry.card;
    if (!card) return;

    // 1) a classe do card — é o que o CSS usa pra cor da borda
    try {
      card.classList.remove('verde', 'amarelo', 'vermelho');
      card.classList.add(novaCor);
      if (isConcorrente) card.classList.add('concorrente');
      else card.classList.remove('concorrente');
    } catch (e) { console.warn('[V4] classe do card:', e); }

    // 2) o selo do farol dentro do card
    try { renderFarol(entry, novaCor, isConcorrente); }
    catch (e) { console.warn('[V4] selo do farol:', e); }

    // 3) só então a trilha e o contador — se falharem, o card já está certo
    try { renderRail(); } catch (e) { console.warn('[V4] trilha:', e); }
    try { renderProducao(); } catch (e) { console.warn('[V4] produção:', e); }
  }

  function renderFarol(entry, cor, isConcorrente) {
    const wrap = entry.card.querySelector('.v4-card-verdict');
    if (!wrap) return;
    const chave = isConcorrente ? 'concorrente' : cor;
    const f = FAROL[chave] || FAROL.amarelo;
    const classe = isConcorrente ? `${cor} concorrente` : cor;
    wrap.innerHTML = `
      <div class="v4-farol ${classe}">
        <div class="v4-farol-luz">${f.luz}</div>
        <div class="v4-farol-txt">${f.txt}</div>
        ${entry.farol && entry.farol.motivo && (cor === 'vermelho' || isConcorrente) ? `<div class="v4-farol-motivo">${esc(entry.farol.motivo.slice(0, 44))}</div>` : ''}
      </div>
      <div class="v4-farol-sub">${entry.elapsed}s${entry.elapsedM2 ? ` + ${entry.elapsedM2}s` : ''} · ${esc((entry.m1 && entry.m1._src) || 'ia')}${entry.m1 && entry.m1._fallback
        ? ` <span style="color:#F59E0B" title="O Gemini não respondeu a tempo e a análise veio da OpenAI, que não busca na web. Sem CNPJ, sem QSA — só o conhecimento do modelo. Clique em ↻ Refazer para tentar o Gemini de novo.">⤵ sem busca</span>`
        : ''}${(() => {
        // v18.7: quantas buscas o grounding realmente fez. Zero com o Gemini
        // ligado significa que ele respondeu só com o conhecimento do modelo —
        // e isso explica "empresa não existe" em empresa que o Google acha.
        // v23.2: com M2, mostra os dois tempos — dava pra ver só o do M1
        const q = (entry.queriesM2 != null ? entry.queriesM2 : entry.queriesM1);
        if (q == null) return '';
        return q === 0
          ? ` · <span style="color:#F59E0B" title="O Gemini não fez nenhuma busca neste lead — respondeu só com o conhecimento do modelo. É a explicação provável quando ele diz que a empresa não existe.">0 buscas ⚠</span>`
          : ` · <span style="color:#6A6A6A" title="buscas que o grounding do Gemini fez neste lead">${q} busca${q > 1 ? 's' : ''}</span>`;
      })()}</div>
    `;
  }

  // ═══════════════════════════════════════════════════════════════
  // TRILHA DE FARÓIS (v9.17)
  // ═══════════════════════════════════════════════════════════════
  let selecionado = null;

  function corDoCard(entry) {
    const c = entry.card.classList;
    if (c.contains('verde')) return 'verde';
    if (c.contains('amarelo')) return 'amarelo';
    if (c.contains('vermelho')) return 'vermelho';
    if (c.contains('error')) return 'vermelho';
    return 'processing';
  }

  function selecionarCard(entry) {
    selecionado = entry || null;
    queue.forEach(q => q.card.classList.toggle('sel', q === selecionado));
    if (selecionado) selecionado.card.classList.add('expanded');
    setTimeout(() => { bodyEl.scrollTop = 0; }, 20);
    renderRail();
    renderProducao();
  }

  function renderRail() {
    if (!railEl || !temTrilha()) return;
    // v9.18: seleção nula = visão de produção. Não força mais escolher um lead.
    if (selecionado && !queue.includes(selecionado)) selecionado = null;

    const itemProd = `<div class="v4-rail-item prod ${selecionado === null ? 'sel' : ''}" data-prod="1">
        <span class="v4-rail-luz">◉</span>
        <span class="v4-rail-txt">
          <span class="v4-rail-nome">Produção</span>
          <span class="v4-rail-est">${queue.filter(q => q.state === 'running' || q.state === 'pending').length || queue.length} leads</span>
        </span>
      </div>`;

    if (!queue.length) { railEl.innerHTML = itemProd; return; }

    // v9.24: mais recente no topo. A fila é push (antigo → novo), então inverte
    // aqui preservando o índice original pro clique.
    const ordem = queue.map((q, i) => ({ q, i })).reverse();

    railEl.innerHTML = itemProd + '<div class="v4-rail-lbl">Farol</div>' + ordem.map(({ q, i }) => {
      // v16.11: a trilha lia as CLASSES CSS do card — uma terceira fonte de
      // verdade pro mesmo dado. Agora lê o entry.farol, igual ao card e ao
      // histórico, e mostra até onde a investigação chegou.
      const processando = q.state === 'running' || q.state === 'pending';
      const cor = processando ? 'processing'
                : (q.farol ? q.farol.cor : corDoCard(q));
      const conc = q.farol ? !!q.farol.conc : q.card.classList.contains('concorrente');
      const f = FAROL[conc ? 'concorrente' : cor] || { luz: '⏳', txt: 'analisando' };
      const nome = q.extracted.nomeEmpresa || 'sem nome';
      // até onde foi: M1 → M2 → M3
      const fase = q.m3 ? '<span style="opacity:.55" title="dossiê gerado">·3</span>'
                 : q.m2 ? '<span style="opacity:.55" title="aprofundado">·2</span>'
                 : '';
      return `<div class="v4-rail-item ${cor} ${conc ? 'concorrente' : ''} ${q === selecionado ? 'sel' : ''}" data-i="${i}">
          <span class="v4-rail-luz">${cor === 'processing' ? '⏳' : f.luz}</span>
          <span class="v4-rail-txt">
            <span class="v4-rail-nome">${esc(nome)}${fase}</span>
            <span class="v4-rail-est">${cor === 'processing' ? 'analisando' : f.txt}</span>
          </span>
        </div>`;
    }).join('');

    railEl.querySelectorAll('.v4-rail-item').forEach(el => {
      el.addEventListener('click', () => {
        if (el.hasAttribute('data-prod')) { selecionarCard(null); return; }
        const q = queue[parseInt(el.getAttribute('data-i'))];
        if (q) selecionarCard(q);
      });
    });
    queue.forEach(q => q.card.classList.toggle('sel', q === selecionado));
  }

  // ═══════════════════════════════════════════════════════════════
  // VISÃO DE PRODUÇÃO (v9.18)
  // Tela base do lado direito: mostra o que o robô está processando.
  // Clicar num lead abre o detalhe; "◉ Produção" na trilha traz de volta.
  // ═══════════════════════════════════════════════════════════════
  let prodTimer = null;

  function estadoLinha(q) {
    if (q.state === 'running') return { cls: 'processing', luz: '⏳', txt: 'analisando' };
    if (q.state === 'pending') return { cls: 'pending', luz: '⋯', txt: 'na fila' };
    if (q.state === 'error') return { cls: 'vermelho', luz: '⚠️', txt: 'erro' };
    const cor = corDoCard(q);
    const conc = q.card.classList.contains('concorrente');
    const f = FAROL[conc ? 'concorrente' : cor] || FAROL.amarelo;
    return { cls: cor, luz: f.luz, txt: f.txt };
  }

  function renderProducao() {
    if (!prodEl) return;
    const naProd = selecionado === null && temTrilha();
    prodEl.classList.toggle('on', naProd);
    if (!naProd) { pararTimerProd(); return; }

    if (!queue.length) {
      prodEl.innerHTML = `<div class="v4-prod-vazio">
        <b style="color:#4ADE80">⚡ Marque o texto do lead na página</b><br>
        A análise dispara sozinha e aparece aqui.<br><br>
        <span style="opacity:.7">A fila roda ${MAX_PARALLEL} em paralelo.</span>
      </div>`;
      pararTimerProd();
      return;
    }

    // v9.26: mais recente no topo em TODAS as listas — assim o lead que você
    // acabou de marcar aparece na primeira linha, sem precisar rolar.
    const run = queue.filter(q => q.state === 'running').slice().reverse();
    const wait = queue.filter(q => q.state === 'pending').slice().reverse();
    // v9.24: prontos do mais recente pro mais antigo, igual à trilha
    const prontos = queue.filter(q => q.state !== 'running' && q.state !== 'pending').slice().reverse();
    const tally = { verde: 0, amarelo: 0, vermelho: 0 };
    prontos.forEach(q => { const c = corDoCard(q); if (tally[c] != null) tally[c]++; });

    const linha = q => {
      const e = estadoLinha(q);
      const meta = [
        q.extracted.tier || '',
        q.state === 'running' ? `${q.elapsed}s` : '',
      ].filter(Boolean).join(' · ');
      return `<div class="v4-prod-linha ${e.cls}" data-id="${q.id}">
          <span class="v4-prod-luz">${e.luz}</span>
          <span class="v4-prod-nome">${esc(q.extracted.nomeEmpresa || 'sem nome')}</span>
          <span class="v4-prod-meta">${esc(meta)}</span>
          <span class="v4-prod-est">${e.txt}</span>
        </div>`;
    };

    prodEl.innerHTML = `
      <div class="v4-prod-topo">
        <div class="v4-prod-kpi go"><b>${tally.verde}</b><span>GO</span></div>
        <div class="v4-prod-kpi caution"><b>${tally.amarelo}</b><span>Caution</span></div>
        <div class="v4-prod-kpi stop"><b>${tally.vermelho}</b><span>Stop</span></div>
        <div class="v4-prod-kpi run"><b>${run.length + wait.length}</b><span>na esteira</span></div>
      </div>
      ${run.length ? `<div class="v4-prod-sec">Analisando agora</div>${run.map(linha).join('')}` : ''}
      ${wait.length ? `<div class="v4-prod-sec">Aguardando vaga</div>${wait.map(linha).join('')}` : ''}
      ${prontos.length ? `<div class="v4-prod-sec">Prontos — clique para ver</div>${prontos.map(linha).join('')}` : ''}
    `;

    prodEl.querySelectorAll('.v4-prod-linha').forEach(el => {
      el.addEventListener('click', () => {
        const q = queue.find(x => x.id === parseInt(el.getAttribute('data-id')));
        if (q) selecionarCard(q);
      });
    });

    if (run.length || wait.length) iniciarTimerProd();
    else pararTimerProd();
  }

  function iniciarTimerProd() {
    if (prodTimer) return;
    prodTimer = setInterval(() => {
      if (selecionado !== null || !temTrilha()) { pararTimerProd(); return; }
      renderProducao();
    }, 700);
  }

  function pararTimerProd() {
    if (prodTimer) { clearInterval(prodTimer); prodTimer = null; }
  }

  function checkBlock(kind, label, detail) {
    const icon = kind === 'ok' ? '✅' : kind === 'warn' ? '⚠️' : kind === 'bad' ? '❌' : '⏳';
    return `<div class="v4-check ${kind}"><div class="v4-check-icon">${icon}</div><div class="v4-check-body">
      <div class="v4-check-label">${esc(label)}</div>
      <div class="v4-check-detail">${detail}</div></div></div>`;
  }

  function renderM1(entry) {
    const { m1, extracted: ex, card } = entry;
    // v9.9: derruba classificação de concorrente sem empresa identificada
    entry.empAmbigua = checarEmpresaIdentificada(m1);
    entry.concInvalido = checarConcorrenteSemIdentificacao(m1);
    const isConc = m1.is_concorrente === true && !entry.concInvalido;
    // v9.28: "nao" sem busca esgotada vira "parcial" — não descarta o lead
    entry.buscaFraca = null;
    let empBruto = m1.empresa_existe;
    if (empBruto === 'nao') {
      const be = buscaEsgotada(m1);
      if (!be.esgotada) {
        entry.buscaFraca = be;
        empBruto = 'parcial';
      }
    }
    const emp = entry.empAmbigua ? 'parcial' : empBruto;
    const dec = m1.decisor_confirmado;

    // v11.0: a cor vem do farol (soma dos 4 boxes), em renderBoxes
    card.classList.remove('processing');

    // badge
    const title = card.querySelector('.v4-card-title');
    const oldBadge = title.querySelector('.v4-badge-concorrente');
    if (oldBadge) oldBadge.remove();
    if (isConc) {
      title.insertAdjacentHTML('beforeend', '<span class="v4-badge-concorrente">🚨 concorrente</span>');
    }



    // 3 checks
    const cConc = isConc
      ? checkBlock('bad', 'Concorrente', `<b style="color:#FCA5A5">SIM — não dê lance.</b> ${esc(m1.concorrente_evidencia || '')}`)
      : m1.is_concorrente === false
      ? checkBlock('ok', 'Concorrente', `não — ${esc(m1.ramo_aparente || m1.concorrente_evidencia || 'ramo diferente de marketing')}`)
      : entry.concInvalido
      ? checkBlock('warn', 'Concorrente · não classificável',
          `<b style="color:#FBBF24">não dá pra afirmar.</b> ${esc(entry.concInvalido.motivo)}<br>`
          + (m1.concorrente_evidencia ? `<span style="opacity:.8">o que a investigação disse: ${esc(m1.concorrente_evidencia)}</span><br>` : '')
          + '<span style="opacity:.8">SDR confirma o ramo na abertura da ligação.</span>')
      : m1.concorrente_suspeita
      ? checkBlock('warn', 'Concorrente · suspeita pelo nome',
          'o nome sugere agência, mas <b>não achei evidência</b> de serviço prestado a terceiros.<br>' +
          '<span style="opacity:.8">Não é veto — momento 2 aprofunda, ou o SDR confirma na ligação.</span>')
      : checkBlock('warn', 'Concorrente', 'não determinado — SDR valida na ligação');

    // v9.16: corta o endereço da evidência — ele aparece nos dados oficiais
    let evEmp = String(m1.empresa_evidencia || '').trim();
    if (evEmp.length > 190) evEmp = evEmp.slice(0, 187).replace(/[\s,;.]+\S*$/, '') + '…';
    const empDetail = [
      esc(evEmp),
      normalizarUrl(m1.site) ? `<a href="${esc(normalizarUrl(m1.site))}" target="_blank" rel="noopener">site</a>` : '',
      m1.instagram ? esc(m1.instagram) : '',
    ].filter(Boolean).join(' · ');
    // v9.22: se a empresa tem âncora concreta (site/CNPJ/Insta), homônimo de outro
    // país ou de outro ramo não gera dúvida — só polui. Caso real: "MyCase"
    // com site e CNPJ próprios, listando software jurídico dos EUA como homônimo.
    const temAncora = !!(normalizarUrl(m1.site) || m1.cnpj_descoberto || entry.cnpjResolvido || m1.instagram);
    const homsBrutos = m1.homonimos_encontrados || [];
    const homs = temAncora
      ? homsBrutos.filter(h => !/\b(EUA|USA|Estados Unidos|internacional|americana?|Portugal|Espanha|Lisboa|Miami|software de gest[ãa]o|plataforma)\b/i.test(String(h)))
      : homsBrutos;
    const homOcultos = homsBrutos.length - homs.length;
    const homHtml = homs.length
      ? `<br><span style="color:#F59E0B">⚠ homônimos que NÃO são esta empresa: ${homs.map(h => esc(h)).join(' · ')}</span>`
      : homOcultos
      ? `<br><span style="opacity:.55">${homOcultos} homônimo(s) de outro país/ramo ignorado(s) — empresa confirmada por âncora própria</span>`
      : '';
    const cEmp = emp === 'sim'
      ? checkBlock('ok', 'Empresa existe', (empDetail || 'confirmada') + homHtml)
      : entry.empAmbigua
      ? checkBlock('warn', 'Empresa · não identificada',
          `<b style="color:#FBBF24">existem empresas com esse nome, mas não se sabe qual é o lead.</b><br>`
          + `<span style="opacity:.85">${esc(entry.empAmbigua.motivo)}</span><br>`
          + `<span style="opacity:.8">${esc(empDetail || '')}</span>` + homHtml)
      : entry.buscaFraca
      ? checkBlock('warn', 'Empresa · busca incompleta',
          '<b style="color:#FBBF24">a investigação não achou nada, mas não esgotou as rotas.</b><br>'
          + `<span style="opacity:.85">não testou: ${esc(entry.buscaFraca.faltou)}</span><br>`
          + '<span style="opacity:.8">Muito negócio pequeno só existe no Instagram. '
          + 'Rode o momento 2 antes de descartar.</span>' + homHtml)
      : emp === 'parcial'
      ? checkBlock('warn', 'Empresa existe', `parcial — ${empDetail || 'evidência isolada'}` + homHtml)
      : checkBlock('bad', 'Empresa existe', 'nenhum rastro desta empresa no Brasil' + homHtml);

    const tierNota = validarDecisorPorTier(m1.decisor_papel, ex.tier);
    const cargoDivergente = m1.cargo_declarado_confere === false && ex.cargo;
    const decDetail = [
      m1.decisor_papel ? `<b>${esc(m1.decisor_papel)}</b>` : '',
      cargoDivergente ? `<span style="color:#F59E0B">⚠ cadastro diz "${esc(ex.cargo)}"</span>` : '',
      m1.contato_na_aba_pessoas === true ? '<b style="color:#4ADE80">✓ listado na aba Pessoas do LinkedIn</b>' : '',
      m1.decisor_fonte && FONTE_VALIDA.includes(m1.decisor_fonte) ? `<span style="opacity:.7">fonte: ${esc(m1.decisor_fonte.replace(/_/g, ' '))}</span>` : '',
      m1.contato_na_aba_pessoas === false && m1.linkedin_empresa ? '<span style="color:#F59E0B">não aparece na aba Pessoas</span>' : '',
      esc(m1.decisor_evidencia || ''),
      normalizarUrl(m1.linkedin_contato) ? `<a href="${esc(normalizarUrl(m1.linkedin_contato))}" target="_blank" rel="noopener">perfil</a>` : '',
      normalizarUrl(m1.linkedin_empresa) ? `<a href="${esc(normalizarUrl(m1.linkedin_empresa))}" target="_blank" rel="noopener">empresa</a>` : '',
      tierNota.nota ? `<span style="opacity:.7">${esc(tierNota.nota)}</span>` : '',
    ].filter(Boolean).join(' · ');
    // v9.6: se a prova de cargo é inválida (avaliação, comentário), rebaixa
    const evRuim = checarEvidenciaDecisor(m1);
    let st = m1.decisor_status || (dec === 'sim' ? 'confirmado' : dec === 'parcial' ? 'indicio' : 'nao');
    if (evRuim && st !== 'nao') st = 'indicio';
    let cDec;
    if (st === 'confirmado' && tierNota.ok !== false) {
      cDec = checkBlock('ok', 'Decisor', decDetail || 'confirmado');
    } else if (st === 'confirmado') {
      cDec = checkBlock('warn', 'Decisor', decDetail);
    } else if (st === 'sem_alcada') {
      cDec = checkBlock('warn', 'Decisor · sem alçada',
        (decDetail || 'cargo sem poder de decisão') +
        '<br><span style="opacity:.8">Lead segue bom — SDR mapeia quem decide: "além de você, quem mais participa dessa decisão?"</span>');
    } else if (st === 'indicio') {
      cDec = checkBlock('warn', 'Decisor',
        evRuim
          ? `<span style="color:#F59E0B">⚠ ${esc(evRuim.texto)}</span><br>`
            + `<span style="opacity:.8">o que a IA achou: ${esc(m1.decisor_evidencia || '')}</span><br>`
            + '<span style="opacity:.8">SDR precisa confirmar o papel na ligação.</span>'
          : (decDetail || 'indício isolado — não confirmado'));
    } else {
      cDec = checkBlock('bad', 'Decisor', 'não encontrado — momento 2 investiga mais fundo');
    }

    card.querySelector('.v4-checks').innerHTML = cConc + cEmp + cDec;

    // tags
    const tags = [];
    if (ex.tier) tags.push(`<span class="v4-tag"><b>Tier</b> ${ex.tier}</span>`);
    if (ex.faturamento) tags.push(`<span class="v4-tag"><b>Fat.</b> ${esc(ex.faturamento)}</span>`);
    if (ex.segmento) tags.push(`<span class="v4-tag"><b>Segmento decl.</b> ${esc(ex.segmento)}</span>`);
    if (m1.ramo_aparente) tags.push(`<span class="v4-tag"><b>Ramo real</b> ${esc(m1.ramo_aparente)}</span>`);
    if (ex.regiao) tags.push(`<span class="v4-tag" title="Pista de desempate — portabilidade permite DDD de outra praça"><b>DDD ${ex.ddd}</b> ${esc(ex.regiao.texto)}</span>`);
    else if (ex.zona) tags.push(`<span class="v4-tag"><b>Zona</b> ${ex.zona}</span>`);
    if (m1.funcionarios_linkedin) tags.push(`<span class="v4-tag"><b>LinkedIn</b> ${esc(m1.funcionarios_linkedin)} funcionários</span>`);
    if (m1.dominio_confere === true) tags.push(`<span class="v4-tag" style="border-color:#16A34A40;color:#4ADE80"><b>✓ domínio</b> confere${m1.dominio_evidencia ? ' — ' + esc(m1.dominio_evidencia) : ''}</span>`);
    else if (m1.dominio_confere === false) tags.push(`<span class="v4-tag v4-tag-alert"><b>⚠ domínio</b> ${esc(m1.dominio_evidencia || 'não confere com a empresa')}</span>`);
    if (m1.cargo_declarado_confere === false && ex.cargo) tags.push(`<span class="v4-tag v4-tag-alert"><b>⚠ cargo</b> declarado "${esc(ex.cargo)}" ≠ real "${esc(m1.decisor_papel || '?')}"</span>`);
    (ex.sinais || []).forEach(s => {
      if (s.startsWith('⚠') || s.startsWith('🚨')) tags.push(`<span class="v4-tag v4-tag-alert">${esc(s)}</span>`);
      else tags.push(`<span class="v4-tag">${esc(s)}</span>`);
    });
    card.querySelector('.v4-tags').innerHTML = tags.join('');

    if (m1.resumo) {
      card.querySelector('.v4-flagswrap').innerHTML =
        `<div class="v4-fit"><div class="v4-fit-label">Resumo</div><div class="v4-fit-row">${esc(m1.resumo)}</div></div>`;
    }

    renderBoxes(entry);   // v11.0: 4 boxes substituem checks + tags
    enviarParaSheet(entry, 'analise');
  }

  // v9.4/9.7: bloco de coerência do cadastro — só na fase 2
  // v12.0: renderCoerenciaCadastro desativada — a divergência de segmento agora aparece na linha "Ramo real" dos dados.
  function renderCoerenciaCadastro(entry) { return; }

  // v11.0: renderEnderecavel removida — os 4 boxes ocuparam o lugar.

  function applyOficial(entry) {
    const { oficial: e, qsaMatch, card } = entry;
    if (!e) return;

    // v8.4: cruzar porte/capital da Receita com o faturamento declarado
    const ex = entry.extracted;
    // v18.0: dado incerto informa, conclusão incerta engana.
    // Quando o CNPJ não bate com o cadastro, os dados continuam na tela como
    // referência — mas nada de flag de porte, regime ou irregularidade fiscal,
    // porque essas viriam JULGADAS e ninguém repondera na pressa do leilão.
    // "CNAE 4651602, não confirmado" quem compra sabe ponderar;
    // "13x acima do limite legal" já vem com veredito embutido.
    const cnpjOk = !entry.cnpjErrado;
    entry.coerenciaPorte = cnpjOk
      ? checarCoerenciaPorte(e.porte, ex.faturamentoMin, e.capital_social, e.abertura) : null;
    entry.alertaCapital = cnpjOk ? checarCapital(e.capital_social, ex.faturamentoMin) : null;
    // v16.0: natureza jurídica e cruzamento do contato com o cadastro público
    entry.natureza = lerNatureza(e, ex.nomeContato);
    entry.contatoCadastro = compararContatoCadastro(entry);
    entry.porteMaior = cnpjOk ? checarPorteMaior(entry) : null;
    entry.cnaeVsRazao = compararCnaeRazao(e);

    // v18.5: a IA às vezes devolve um CNPJ que ela mesma achou na busca, sem
    // passar pela Receita. Caso RP PRIME: cadastro 03.87, IA trouxe
    // 39.438.278/0001-80 e o card mostrava como se fosse o CNPJ do lead.
    // Esse também tem que ser confrontado.
    const mIA = entry.m2 || entry.m1 || {};
    const cnpjIA = String(mIA.cnpj || '').replace(/\D/g, '');
    if (cnpjIA.length === 14 && !entry.oficial) {
      const cIA = confrontarCnpj(cnpjIA, ex.cnpjParcial);
      if (cIA && !cIA.bate) entry.cnpjErrado = cIA;
    }
    entry.nomeBate = nomeBateComEmpresa(ex.nomeEmpresa, e);
    // v16.11: com os dados oficiais em mãos, decide se vale aprofundar sozinho
    setTimeout(() => { try { enfileirarM2(entry); } catch (err) {} }, 300);
    if ((entry.coerenciaPorte && entry.coerenciaPorte.coerente === false) || entry.alertaCapital) {
      renderContradicaoFaturamento(entry);
    }
    if (entry.m1) { try { renderBoxes(entry); } catch (err) { console.warn('[V4] boxes:', err); } }

    // badge de sócio confirmado
    if (qsaMatch) {
      const conf = qsaMatch.confianca;
      const alta = conf === 'alta';
      const t = card.querySelector('.v4-card-title');
      if (t && !t.querySelector('.v4-badge-socio')) {
        t.insertAdjacentHTML('beforeend',
          // v16.5: o badge tem que refletir o BOX, senão o card se contradiz —
          // "💎 SÓCIO NO QSA" no topo com o box de decisor amarelo embaixo.
          // O box já foi calculado em renderBoxes, então basta ler a cor dele.
          (entry.boxes && entry.boxes.decisor && entry.boxes.decisor.cor === 'verde')
            ? '<span class="v4-badge-socio">💎 sócio no QSA</span>'
            : `<span class="v4-badge-socio" style="background:linear-gradient(135deg,#D97706,#B45309);color:#FEF3C7">💎 QSA · a confirmar</span>`);
      }
      const checks = card.querySelectorAll('.v4-check');
      if (checks[2]) {
        const linhas = [
          `<b>${esc(qsaMatch.socio.nome)}</b> — ${esc(qsaMatch.socio.qualificacao || 'sócio')}`,
          `<span style="opacity:.85">base do match: ${esc(qsaMatch.base)}</span>`,
          qsaMatch.reforcos.length ? `<span style="color:#FDE68A">reforço: ${esc(qsaMatch.reforcos.join(' · '))}</span>` : '',
          qsaMatch.ambiguo
            ? `<span style="color:#F59E0B">⚠ AMBÍGUO — mais de um sócio bate: ${esc((qsaMatch.empatados || []).join(' · '))}. SDR confirma qual.</span>`
            : '',
          conf === 'baixa' ? '<span style="color:#F59E0B">⚠ coincidência de nomes comuns — pode ser outra pessoa</span>' : '',
        ].filter(Boolean).join('<br>');

        checks[2].className = alta ? 'v4-check ok' : 'v4-check warn';
        checks[2].innerHTML = `<div class="v4-check-icon">${alta ? '✅' : '⚠️'}</div><div class="v4-check-body">
          <div class="v4-check-label">Decisor · QSA da Receita (confiança ${esc(conf)})</div>
          <div class="v4-check-detail">${linhas}</div></div>`;
      }
      // v16.3: esta lógica é da v9, quando o farol vinha do decisor. Com o farol
      // sendo a SOMA dos 4 boxes, forçar verde aqui produzia GO com dois boxes
      // amarelos — foi o que aconteceu no KEIZO.
      // Agora recalcula em vez de pintar.
      if (entry.m1) { try { renderBoxes(entry); } catch (e) { console.warn('[V4] boxes:', e); } }
    }

    // v8.19: parentesco por sobrenome promove o decisor de "não encontrado"
    const par = entry.parentesco;
    if (par && !qsaMatch) {
      const checks2 = card.querySelectorAll('.v4-check');
      if (checks2[2]) {
        const cor = par.forca === 'alta' ? '#FDE68A' : '#FCD34D';
        checks2[2].className = 'v4-check warn';
        checks2[2].innerHTML = `<div class="v4-check-icon">⚠️</div><div class="v4-check-body">
          <div class="v4-check-label">Decisor · possível familiar</div>
          <div class="v4-check-detail">
            <b style="color:${cor}">${esc(par.sobrenomes)}</b> — ${esc(par.nota)}<br>
            <span style="opacity:.85">${esc(par.resumo)}</span><br>
            <span style="opacity:.7">SDR: perguntar a relação com os sócios e quem decide.</span>
          </div></div>`;
      }
      const t = card.querySelector('.v4-card-title');
      if (t && !t.querySelector('.v4-badge-fam')) {
        t.insertAdjacentHTML('beforeend',
          `<span class="v4-badge-fam" style="background:linear-gradient(135deg,#FACC15,#EAB308);color:#422006;font-size:9px;font-weight:800;letter-spacing:.5px;padding:2px 7px;border-radius:3px;text-transform:uppercase">👪 possível familiar</span>`);
      }
      // v16.3: recalcula em vez de pintar por fora
      if (entry.m1) { try { renderBoxes(entry); } catch (e) { console.warn('[V4] boxes:', e); } }
    }

    // v12.0: o bloco visual "📋 Dados oficiais" foi REMOVIDO — repetia CNPJ,
    // CNAE, situação, porte, capital e QSA, que já aparecem em "Dados
    // encontrados". Os dados continuam calculados e alimentam os boxes,
    // a checagem de coerência e o dossiê do momento 3.
  }

  // v12.0: renderContradicaoFaturamento desativada — a contradição agora aparece como etiqueta na linha "Faturamento".
  function renderContradicaoFaturamento(entry) { return; }

  function renderActions(entry) {
    const w = entry.card.querySelector('.v4-actions');
    const hasM2 = !!entry.m2, hasM3 = !!entry.m3;
    w.innerHTML = `
      <button class="v4-act v4-act-m2" data-act="m2" ${hasM2 ? 'disabled' : ''}>
        ${hasM2 ? '✓ aprofundado' : '🔍 Momento 2 — aprofundar'}
      </button>
      <button class="v4-act" data-act="refazer" style="border-color:#3A3A3A;color:#8A8A8A" title="Ignora o cache e consulta as APIs de novo">↻ Refazer</button>
      ${modoTime() ? '' : `
      <button class="v4-act v4-act-m3" data-act="m3" ${hasM3 ? 'disabled' : ''}>
        ${hasM3 ? '✓ dossiê gerado' : '📄 Momento 3 — dossiê SDR'}
      </button>`}
      ${modoTime() ? '' : `
      <div class="v4-outcome-label">Resultado</div>
      <button class="v4-act ${entry.outcome === 'comprei' ? 'on' : ''}" data-out="comprei">Arrematei</button>
      <button class="v4-act ${entry.outcome === 'passei' ? 'on' : ''}" data-out="passei">Passei</button>
      <button class="v4-act ${entry.outcome === 'cliente' ? 'on' : ''}" data-out="cliente">Virou cliente</button>`}
    `;

    w.querySelectorAll('[data-act]').forEach(b => {
      b.addEventListener('click', () => {
        const a = b.getAttribute('data-act');
        if (a === 'm2') doM2(entry);
        if (a === 'm3') doM3(entry);
        if (a === 'refazer') refazerAnalise(entry);
      });
    });
    w.querySelectorAll('[data-out]').forEach(b => {
      b.addEventListener('click', () => {
        const o = b.getAttribute('data-out');
        const marcando = entry.outcome !== o;
        entry.outcome = marcando ? o : null;
        entry.outcomeEm = marcando ? new Date().toISOString() : null;   // v16.1
        saveEntry(entry);
        enviarParaSheet(entry, 'resultado');   // v13.0: fecha o loop no histórico central
        renderActions(entry);
        // arrematou e ainda não tem dossiê → oferece gerar
        if (marcando && o === 'comprei' && !entry.m3) {
          setTimeout(() => {
            if (confirm('Arrematado! Gerar o dossiê pro SDR agora?\n\n(sai em arquivo único pra colar no agendamento do CRM)')) {
              doM3(entry);
            }
          }, 200);
        }
      });
    });
  }

  async function doM2(entry) {
    const w = entry.card.querySelector('.v4-m2wrap');
    w.innerHTML = `<div class="v4-sec"><div class="v4-sec-title">🔍 Momento 2 — aprofundando</div>
      <div class="v4-sec-box"><div class="v4-loading"><span class="v4-spinner"></span>
      <span>Esgotando variações de busca, cruzando contato × empresa, procurando QSA…</span></div></div></div>`;
    const btn = entry.card.querySelector('[data-act="m2"]');
    if (btn) btn.disabled = true;

    try {
      const t0M2 = Date.now();
      const m2 = await runMomento2(entry.extracted, entry.m1 || {});
      entry.elapsedM2 = ((Date.now() - t0M2) / 1000).toFixed(1);   // v23.2
      if (m2 && m2._uso && typeof m2._uso.queries === 'number') entry.queriesM2 = m2._uso.queries;
      entry.m2 = m2;
      computeFit(entry);
      renderM2(entry);
      renderBoxes(entry);
      enviarParaSheet(entry, 'momento2');
      renderCoerenciaCadastro(entry);

      // CNPJ novo?
      const c = m2.cnpj_descoberto && String(m2.cnpj_descoberto).replace(/[^\d]/g, '');
      if (c && c.length === 14 && !entry.oficial) {
        const r = await buscarOficial(c, entry.extracted);
        if (r && r.empresa) {
          const conf2 = confrontarCnpj(r.empresa.cnpj, entry.extracted.cnpjParcial);
          if (conf2 && !conf2.bate) {
            entry.cnpjErrado = conf2;
            console.warn('[V4] CNPJ descartado (M2):', conf2.texto);
            try { renderBoxes(entry); } catch (e) {}
            return;
          }
          entry.cnpjConfirmado = conf2 && conf2.bate ? conf2 : null;
          entry.oficial = r.empresa; entry.oficialFontes = r.fontes;
          entry.qsaMatch = r.qsaMatch; entry.parentesco = r.parentesco;
          entry.cnpjResolvido = r.empresa.cnpj;
          applyOficial(entry);
        }
      }
      // atualiza checks com o resultado mais recente
      mergeM2IntoChecks(entry);
      saveEntry(entry);
      renderActions(entry);
    } catch (e) {
      w.innerHTML = `<div class="v4-sec"><div class="v4-sec-title">🔍 Momento 2</div>
        <div class="v4-sec-box"><div style="color:#FCA5A5;font-size:11px">⚠️ ${esc(e.message)}</div></div></div>`;
      if (btn) btn.disabled = false;
    }
  }

  function mergeM2IntoChecks(entry) {
    const { m2, m1, card, extracted: ex } = entry;
    if (!m2) return;
    const checks = card.querySelectorAll('.v4-check');

    // v8.13: avisar quando os dois momentos discordam
    const div = [];
    if (m1 && m1.is_concorrente !== m2.is_concorrente && (m1.is_concorrente != null || m2.is_concorrente != null))
      div.push(`concorrente: momento 1 disse "${m1.is_concorrente}" · momento 2 disse "${m2.is_concorrente}"`);
    if (m1 && m1.empresa_existe && m2.empresa_existe && m1.empresa_existe !== m2.empresa_existe)
      div.push(`empresa existe: "${m1.empresa_existe}" vs "${m2.empresa_existe}"`);
    // v17.11: comparar os 12 primeiros caracteres acusava sinônimo como
    // contradição. "Açougue / Casa de Carnes" vs "Comércio varejista de carnes
    // - açougues" é a MESMA atividade escrita de dois jeitos.
    // Agora só é divergência quando caem em buckets diferentes da régua,
    // ou quando não compartilham nenhuma palavra significativa.
    if (m1 && m1.ramo_aparente && m2.ramo_real) {
      const a = normalizarTexto(m1.ramo_aparente);
      const b = normalizarTexto(m2.ramo_real);
      const bA = classificarMargem(m1.ramo_aparente);
      const bB = classificarMargem(m2.ramo_real);

      // palavras com peso, ignorando conectivos e termos de catálogo
      const VAZIAS = /^(de|da|do|das|dos|e|em|com|para|por|a|o|as|os|ou|comercio|varejista|varejo|atacadista|atacado|servicos?|servico|outros?|nao|especificados|anteriormente|geral|tipos?|qualquer|material|produtos?|artigos?|ltda|me|epp)$/;
      const pal = (t) => new Set(t.split(/\s+/).filter(p => p.length > 3 && !VAZIAS.test(p)));
      const pA = pal(a), pB = pal(b);
      const comuns = [...pA].filter(p => pB.has(p) || [...pB].some(q => q.startsWith(p.slice(0, 5)) || p.startsWith(q.slice(0, 5))));

      // v17.11: o SEGMENTO decide, não o bucket. Agência e clínica são ambos
      // margem alta mas negócios diferentes; padaria e massas frescas caem no
      // mesmo segmento e não são divergência. Quando a régua não classifica um
      // dos dois, cai na comparação por palavras.
      const segDiferente = !!(bA && bB && bA.nome !== bB.nome);
      const semPalavraEmComum = (!bA || !bB) && pA.size > 0 && pB.size > 0 && comuns.length === 0;

      if (segDiferente || semPalavraEmComum) {
        div.push(`ramo: "${m1.ramo_aparente}" vs "${m2.ramo_real}"`);
      }
    }
    if (div.length) {
      const w = card.querySelector('.v4-m2wrap');
      if (w && !card.querySelector('.v4-diverg')) {
        w.insertAdjacentHTML('afterbegin', `
          <div class="v4-flags v4-diverg" style="background:rgba(217,119,6,.08);border-color:rgba(217,119,6,.35)">
            <div class="v4-flags-title">⚖ Os dois momentos divergiram</div>
            ${div.map(d => `<div class="v4-flag">${esc(d)}</div>`).join('')}
            <div class="v4-flag" style="opacity:.8;padding-top:5px">
              Divergência costuma indicar empresa não localizada com segurança — SDR confirma na ligação.
            </div>
          </div>`);
      }
    }

    const concInv2 = checarConcorrenteSemIdentificacao(m2);
    entry.concInvalido = concInv2;
    if (concInv2 && checks[0]) {
      checks[0].className = 'v4-check warn';
      checks[0].innerHTML = `<div class="v4-check-icon">⚠️</div><div class="v4-check-body">
        <div class="v4-check-label">Concorrente · não classificável</div>
        <div class="v4-check-detail"><b style="color:#FBBF24">não dá pra afirmar.</b> ${esc(concInv2.motivo)}<br>
        <span style="opacity:.8">SDR confirma o ramo na abertura.</span></div></div>`;
      card.classList.remove('concorrente');
      // v16.3: o resultado do M2 entra pelos boxes, não por pintura direta
      if (entry.m1) { try { renderBoxes(entry); } catch (e) { console.warn('[V4] boxes:', e); } }
    } else if (m2.is_concorrente === true && checks[0]) {
      checks[0].className = 'v4-check bad';
      checks[0].innerHTML = `<div class="v4-check-icon">❌</div><div class="v4-check-body">
        <div class="v4-check-label">Concorrente</div>
        <div class="v4-check-detail"><b style="color:#FCA5A5">SIM (confirmado no momento 2)</b> ${esc(m2.concorrente_evidencia || '')}</div></div>`;
      repintarFarol(entry, 'vermelho', true);
    } else if (m2.is_concorrente === false && checks[0]) {
      checks[0].className = 'v4-check ok';
      checks[0].innerHTML = `<div class="v4-check-icon">✅</div><div class="v4-check-body">
        <div class="v4-check-label">Concorrente</div>
        <div class="v4-check-detail">não — ${esc(m2.ramo_real || 'ramo fora de marketing')}</div></div>`;
      card.classList.remove('concorrente');
    }

    const beM2 = m2.empresa_existe === 'nao' ? buscaEsgotada(m2) : null;
    if (beM2 && !beM2.esgotada) m2.empresa_existe = 'parcial';
    const ambM2 = checarEmpresaIdentificada(m2);
    if (ambM2 && checks[1]) {
      checks[1].className = 'v4-check warn';
      checks[1].innerHTML = `<div class="v4-check-icon">⚠️</div><div class="v4-check-body">
        <div class="v4-check-label">Empresa · não identificada</div>
        <div class="v4-check-detail"><b style="color:#FBBF24">existem empresas com esse nome, mas não se sabe qual é o lead.</b><br>
        <span style="opacity:.85">${esc(ambM2.motivo)}</span></div></div>`;
    } else if (m2.empresa_existe === 'sim' && checks[1]) {
      checks[1].className = 'v4-check ok';
      checks[1].innerHTML = `<div class="v4-check-icon">✅</div><div class="v4-check-body">
        <div class="v4-check-label">Empresa existe</div>
        <div class="v4-check-detail">${esc(m2.empresa_evidencia || 'confirmada no momento 2')}${m2.endereco ? ' · ' + esc(m2.endereco) : ''}</div></div>`;
    }

    const stM2 = m2.decisor_status || (m2.decisor_confirmado === 'sim' ? 'confirmado' : null);
    if ((stM2 === 'confirmado' || stM2 === 'sem_alcada') && checks[2] && !entry.qsaMatch) {
      const tn = validarDecisorPorTier(m2.decisor_papel, ex.tier);
      const semAlc = stM2 === 'sem_alcada' || tn.ok === false;
      checks[2].className = semAlc ? 'v4-check warn' : 'v4-check ok';
      checks[2].innerHTML = `<div class="v4-check-icon">${semAlc ? '⚠️' : '✅'}</div><div class="v4-check-body">
        <div class="v4-check-label">Decisor${semAlc ? ' · sem alçada' : ''}</div>
        <div class="v4-check-detail"><b>${esc(m2.decisor_papel || '')}</b> · ${esc(m2.decisor_evidencia || '')}${m2.empresa_familiar ? ' · <b style="color:#FDE68A">empresa familiar</b>' : ''}${tn.nota ? ` · <span style="opacity:.7">${esc(tn.nota)}</span>` : ''}</div></div>`;
    }

    // v23.4: AQUI estava a divergência que voltou quatro vezes.
    //
    // Este bloco é anterior ao sistema de boxes e repintava o farol com regra
    // própria: "empresa existe E decisor confirmado → verde". Margem e
    // concorrente nunca entravam na conta — e ele rodava DEPOIS do
    // renderBoxes, sobrescrevendo o farol correto.
    //
    // Caso INSTITUTO PRESBITERIANO: empresa sim, decisor confirmado pelo QSA,
    // margem amarela (ICP de R$ 400k com lead de R$ 71k) → os boxes diziam
    // CAUTION, a trilha dizia CAUTION, e o card dizia GO.
    //
    // O farol agora sai de um lugar só: renderBoxes, a partir dos quatro boxes.
  }

  function renderM2(entry) {
    const { m2, card } = entry;
    if (!m2) return;
    const w = card.querySelector('.v4-m2wrap');

    // v9.16: a IA costuma repetir o mesmo item em contradicoes e red_flags
    const dedupe = arr => {
      const vistos = [], out = [];
      for (const x of arr) {
        const n = normalizarTexto(x).replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
        if (!n) continue;
        // considera igual se um contém o outro ou se 80% das palavras coincidem
        const dup = vistos.some(v => {
          if (v.includes(n) || n.includes(v)) return true;
          const a = new Set(n.split(' ').filter(w => w.length > 3));
          const b = new Set(v.split(' ').filter(w => w.length > 3));
          // frases curtas colidem por acaso — só compara as com substância
          if (a.size < 4 || b.size < 4) return false;
          const inter = [...a].filter(w => b.has(w)).length;
          // 60%: duas redações da mesma ideia costumam ficar entre 60 e 75%
          return inter / Math.min(a.size, b.size) >= 0.6;
        });
        if (!dup) { vistos.push(n); out.push(x); }
      }
      return out;
    };
    let flags = dedupe([].concat(m2.contradicoes || [], m2.red_flags || []));
    const flagsHtml = flags.length ? `
      <div class="v4-flags">
        <div class="v4-flags-title">Contradições e red flags</div>
        ${flags.map(f => `<div class="v4-flag">${esc(f)}</div>`).join('')}
      </div>` : '';

    // v13.1: o bloco do Momento 2 virou um muro de texto que repetia ramo,
    // margem, endereço, papel do contato e CNPJ — tudo já nos boxes e nos dados.
    // Agora mostra só o que é NOVO e acionável: as contradições.
    // v14.14: tira das contradições o que o QSA já resolveu
    const qsaResolveu = entry.qsaMatch && (entry.qsaMatch.confianca === 'alta' || entry.qsaMatch.confianca === 'media');
    if (qsaResolveu) {
      const jaResolvido = [
        /n[ãa]o (foi poss[íi]vel associ|h[áa] evid[êe]ncias?|consta|aparece)/i,
        /n[ãa]o foi identificad[oa] como (s[óo]ci|decisor|funcion|administrador)/i,
        /cargo declarado.{0,40}n[ãa]o informado/i,
        /sem (v[íi]nculo|liga[çc][ãa]o) (comprovad|confirmad)/i,
      ];
      flags = flags.filter(f => !jaResolvido.some(re => re.test(String(f))));
    }

    w.innerHTML = flags.length ? `
      <div class="v4-sec">
        <div class="v4-sec-title">⚠ O que confirmar na ligação · momento 2</div>
        <div class="v4-flags">
          ${flags.slice(0, 4).map(f => `<div class="v4-flag">${esc(String(f).slice(0, 150))}</div>`).join('')}
        </div>
      </div>` : `
      <div class="v4-sec">
        <div class="v4-sec-title">✓ Momento 2 · nada a ressalvar</div>
      </div>`;
  }

  async function doM3(entry) {
    const w = entry.card.querySelector('.v4-m3wrap');
    w.innerHTML = `<div class="v4-sec"><div class="v4-sec-title">📄 Momento 3 — dossiê SDR</div>
      <div class="v4-sec-box"><div class="v4-loading"><span class="v4-spinner"></span>
      <span>Consolidando levantamento completo e roteamento de pilar…</span></div></div></div>`;
    const btn = entry.card.querySelector('[data-act="m3"]');
    if (btn) btn.disabled = true;

    try {
      const m3 = await runMomento3(entry);
      entry.m3 = m3;
      renderM3(entry);
      saveEntry(entry);
      renderActions(entry);
    } catch (e) {
      w.innerHTML = `<div class="v4-sec"><div class="v4-sec-title">📄 Momento 3</div>
        <div class="v4-sec-box"><div style="color:#FCA5A5;font-size:11px">⚠️ ${esc(e.message)}</div></div></div>`;
      if (btn) btn.disabled = false;
    }
  }

  function nomeArquivoDossie(entry) {
    const emp = (entry.extracted.nomeEmpresa || 'lead')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40);
    const d = new Date();
    return `dossie-${emp}-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.txt`;
  }

  function renderM3(entry) {
    const w = entry.card.querySelector('.v4-m3wrap');
    w.innerHTML = `
      <div class="v4-sec">
        <div class="v4-sec-title">📄 Dossiê pro SDR</div>
        <div class="v4-sec-box">
          <pre class="v4-pre">${esc(entry.m3)}</pre>
          <div style="display:flex;gap:7px;margin-top:9px;flex-wrap:wrap">
            <button class="v4-act v4-act-m3" data-dl="1">⬇ Baixar arquivo (.txt)</button>
            <button class="v4-act" data-copy="1">📋 Copiar</button>
          </div>
        </div>
      </div>`;

    const dl = w.querySelector('[data-dl]');
    if (dl) dl.addEventListener('click', ev => {
      ev.stopPropagation();
      download(entry.m3, nomeArquivoDossie(entry), 'text/plain;charset=utf-8');
      dl.textContent = '✓ baixado';
      setTimeout(() => { dl.textContent = '⬇ Baixar arquivo (.txt)'; }, 2000);
    });
    const b = w.querySelector('[data-copy]');
    if (b) b.addEventListener('click', ev => {
      ev.stopPropagation();
      navigator.clipboard.writeText(entry.m3);
      b.textContent = '✓ copiado';
      setTimeout(() => { b.textContent = '📋 Copiar'; }, 2000);
    });
  }

  function renderError(entry) {
    const { card } = entry;
    card.classList.remove('processing');
    card.classList.add('error');
    const vw = card.querySelector('.v4-card-verdict');
    if (vw) vw.innerHTML = `
      <div class="v4-farol" style="border-color:#7F1D1D;background:rgba(127,29,29,.18)">
        <div class="v4-farol-luz">⚠️</div>
        <div class="v4-farol-txt" style="color:#FCA5A5">ERRO</div>
      </div>`;
    // v19.2: a mensagem ia pro bloco .v4-checks, que no layout dos 4 boxes não
    // aparece — o card mostrava só "ERRO" sem dizer o quê. Agora vai pro lugar
    // que está visível, e o texto da API aparece inteiro.
    const alvo = card.querySelector('.v4-boxes');
    if (alvo) {
      alvo.innerHTML = `
        <div style="grid-column:1/-1;padding:12px 14px;border-radius:8px;
             background:rgba(127,29,29,.14);border:1px solid rgba(248,113,113,.35)">
          <div style="font-size:11px;font-weight:800;color:#FCA5A5;letter-spacing:.6px">
            ⚠️ FALHA NA ANÁLISE
          </div>
          <div style="font-size:12px;color:#FECACA;margin-top:6px;line-height:1.5;
               word-break:break-word">${esc(entry.error || 'erro desconhecido')}</div>
          <div style="font-size:11px;color:#9A9A9A;margin-top:8px;line-height:1.5">
            Decida manualmente. Clique em <b>🩺 Diagnóstico</b> para testar as APIs,
            ou em <b>↻ Refazer</b> para tentar de novo.
          </div>
        </div>`;
    }
    const checks = card.querySelector('.v4-checks');
    if (checks) checks.innerHTML = '';
  }

  // ═══════════════════════════════════════════════════════════════
  // HEALTH
  // ═══════════════════════════════════════════════════════════════
  function classify(s) {
    if (s === null) return 'unset';
    if (s >= 200 && s < 300) return 'on';
    if (s === 401 || s === 403 || s === 400) return 'auth';
    if (s <= 0) return 'off';
    return 'warn';
  }
  const HMETA = {
    on: { d: '🟢', t: 'ON' }, off: { d: '🔴', t: 'OFF' }, auth: { d: '🟠', t: 'CHAVE?' },
    warn: { d: '🟡', t: '?' }, unset: { d: '⚪', t: 'ativar' },
  };
  function ping(o) {
    return new Promise(res => GM_xmlhttpRequest({
      method: o.method || 'GET', url: o.url, headers: o.headers || {}, timeout: 6000,
      onload: r => res(r.status), onerror: () => res(0), ontimeout: () => res(-1),
    }));
  }
  // Teste FUNCIONAL: valida que o modelo de busca realmente responde.
  // Pingar /v1/models só prova que a chave existe — não pega modelo descontinuado.
  async function testarBuscaOpenAI(key) {
    try {
      await callOpenAISearch('Responda apenas com a palavra OK.', 'teste', key, 12000);
      const usado = GM_getValue('v4_openai_search_ok', '');
      const semBusca = usado.startsWith('plain:');
      return { state: semBusca ? 'warn' : 'on', status: 200, modelo: usado, semBusca };
    } catch (e) {
      const auth = /api key|unauthorized|401|quota|insufficient_quota|billing/i.test(e.message);
      return { state: auth ? 'auth' : 'off', status: auth ? 401 : 0, erro: e.message };
    }
  }

  async function testarGemini(key) {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Responda apenas: OK' }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
        }),
        timeout: 10000,
        onload(r) {
          try {
            const d = JSON.parse(r.responseText);
            if (d.error) {
              const auth = /api key|permission|401|403|quota/i.test(d.error.message || '');
              return resolve({ state: auth ? 'auth' : 'off', status: r.status, erro: d.error.message });
            }
            const cand = d.candidates?.[0];
            const t = (cand?.content?.parts || []).map(p => p.text).filter(Boolean).join('');
            if (!t) return resolve({ state: 'warn', status: r.status, erro: 'resposta vazia (' + (cand?.finishReason || '?') + ')' });
            resolve({ state: 'on', status: 200 });
          } catch (e) { resolve({ state: 'off', status: 0, erro: e.message }); }
        },
        onerror() { resolve({ state: 'off', status: 0, erro: 'rede' }); },
        ontimeout() { resolve({ state: 'off', status: -1, erro: 'timeout' }); },
      });
    });
  }

  async function checkAll(funcional) {
    const ok = GM_getValue('v4_openai_key', ''), gk = GM_getValue('v4_gemini_key', ''), ot = GM_getValue('v4_outbound_token', '');

    // funcional=true → testa geração de verdade (1x/dia). Senão, só credencial.
    const pOpenai = !ok ? Promise.resolve({ state: 'unset', status: null })
      : funcional ? testarBuscaOpenAI(ok)
      : ping({ url: 'https://api.openai.com/v1/models', headers: { Authorization: 'Bearer ' + ok } })
          .then(s => ({ state: classify(s), status: s }));

    const pGemini = !gk ? Promise.resolve({ state: 'unset', status: null })
      : funcional ? testarGemini(gk)
      : ping({ url: 'https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(gk) })
          .then(s => ({ state: classify(s), status: s }));

    const [o, g, ob, br] = await Promise.all([
      pOpenai, pGemini,
      ot ? ping({ url: 'https://app.outboundpro.com.br/api', headers: { Token: ot, 'Content-Type': 'application/json' } })
             .then(s => ({ state: classify(s), status: s }))
         : Promise.resolve({ state: 'unset', status: null }),
      ping({ url: 'https://brasilapi.com.br/api/cnpj/v1/00000000000191' }).then(s => ({ state: classify(s), status: s })),
    ]);
    return { openai: o, gemini: g, outbound: ob, brasil: br, funcional: !!funcional };
  }

  function isStale() {
    if (!v4Health || !v4HealthAt) return true;
    if (Date.now() - v4HealthAt > HEALTH_STALE_MS) return true;
    return new Date(v4HealthAt).toDateString() !== new Date().toDateString();
  }
  function criticalIssue() {
    if (!v4Health) return true;
    const bad = s => s === 'off' || s === 'auth';
    return bad(v4Health.openai.state);
  }
  function healthSummary() {
    if (!v4Health) return 'não verificado';
    const bad = s => s === 'off' || s === 'auth' || s === 'warn';
    const l = [];
    if (bad(v4Health.openai.state)) l.push(`• OpenAI: ${HMETA[v4Health.openai.state].t}${v4Health.openai.erro ? ' — ' + v4Health.openai.erro : ''}`);
    if (v4Health.gemini.state !== 'unset' && bad(v4Health.gemini.state)) l.push(`• Gemini: ${HMETA[v4Health.gemini.state].t}${v4Health.gemini.erro ? ' — ' + v4Health.gemini.erro : ''}`);
    if (v4Health.outbound.state !== 'unset' && bad(v4Health.outbound.state)) l.push(`• OutboundPro: ${HMETA[v4Health.outbound.state].t}`);
    if (bad(v4Health.brasil.state)) l.push(`• BrasilAPI: ${HMETA[v4Health.brasil.state].t}`);
    return l.length ? l.join('\n') : 'tudo OK';
  }
  function hhmm(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  async function refreshHealth(force, funcional) {
    if (!force && v4Health && Date.now() - v4HealthAt < 60000) { renderHealth(); return v4Health; }
    try { renderHealth(true, funcional); } catch (e) { console.warn('[V4] strip:', e); }
    try {
      v4Health = await checkAll(funcional);
      v4HealthAt = Date.now();
    } catch (e) {
      console.warn('[V4] checkAll falhou:', e);
      v4Health = {
        openai: { state: 'warn', status: 0, erro: e.message },
        gemini: { state: 'warn', status: 0 },
        outbound: { state: 'warn', status: 0 },
        brasil: { state: 'warn', status: 0 },
        funcional: false,
      };
      v4HealthAt = Date.now();
    }
    try { renderHealth(); updateFabBadge(); } catch (e) { console.warn('[V4] render:', e); }
    return v4Health;
  }
  function ensureStrip() {
    let s = document.getElementById('v4-health');
    if (s) return s;
    const bar = document.getElementById('v4-add-bar');
    if (!bar || !bar.parentNode) return null;
    s = document.createElement('div');
    s.id = 'v4-health';
    bar.parentNode.insertBefore(s, bar.nextSibling);
    return s;
  }
  function chip(label, h, id) {
    const m = HMETA[h.state] || HMETA.unset;
    const code = h.status && h.status > 0 ? ` ${h.status}` : '';
    const click = h.state === 'unset' && id ? `data-chip="${id}"` : '';
    return `<span class="v4-chip v4-chip-${h.state}" ${click}>${m.d} ${label} <b>${m.t}${code}</b></span>`;
  }
  function renderHealth(loading, loadingFuncional) {
    const s = ensureStrip();
    if (!s) return;
    if (loading || !v4Health) {
      s.innerHTML = `<span class="v4-health-loading">⏳ ${loadingFuncional ? 'testando geração das APIs (pode levar ~10s)…' : 'verificando integrações…'}</span><button class="v4-health-refresh" id="v4-hr">↻</button>`;
    } else {
      const stale = isStale();
      s.innerHTML =
        chip('OpenAI', v4Health.openai, 'openai') +
        chip('Gemini', v4Health.gemini, 'gemini') +
        chip('OutboundPro', v4Health.outbound, 'outbound') +
        // v21.0: a busca crua é o caminho mais rápido pro CNPJ
        (GM_getValue('v4_serper_key', '')
          ? `<span class="v4-chip" style="border-color:#16A34A50;color:#4ADE80" title="Busca web crua: acha o CNPJ em ~1s, antes da IA">⚡ Serper ON</span>`
          : `<span class="v4-chip" style="opacity:.45" title="Sem a busca crua o CNPJ depende da IA achar — mais lento e menos confiável. Configure em ⚙ Mais opções → 🔑 Chaves → 3">⚡ sem Serper</span>`) +
        // v22.0: envio automático pro GHL
        (GM_getValue('v4_ghl_token', '') && GM_getValue('v4_ghl_location', '')
          ? `<span class="v4-chip" style="border-color:#8B5CF650;color:#C4B5FD" title="Lead comprado vai pro GHL automaticamente, com a análise na nota">🔗 GHL ON</span>`
          : '') +
        chip('BrasilAPI', v4Health.brasil) +
        `<span class="v4-chip" style="${stale ? 'border-color:#D9770640;color:#F59E0B' : 'opacity:.6'}" title="${v4Health.funcional ? 'teste funcional (geração real)' : 'só validação de credencial'}">⏰ ${hhmm(v4HealthAt)}${v4Health.funcional ? ' ✓' : ''}${stale ? ' ⚠' : ''}</span>` +
        // v18.4: o aviso era genérico e assustava à toa. A busca web vem do
        // GEMINI, que faz grounding; a OpenAI é o caminho alternativo e nos
        // modelos sem ferramenta de busca roda em modo plain — o que é normal
        // e não tira a busca da análise, desde que o Gemini esteja no ar.
        // Só vira alerta de verdade quando NENHUM dos dois tem busca.
        (() => {
          const geminiOk = v4Health.gemini && v4Health.gemini.state === 'on';
          const openaiSemBusca = v4Health.openai && v4Health.openai.semBusca;
          if (geminiOk) {
            return openaiSemBusca
              ? `<span class="v4-chip" style="opacity:.55" title="A busca web vem do Gemini, que está no ar. A OpenAI é o caminho alternativo e este modelo (${esc(v4Health.openai.modelo || '?')}) não tem ferramenta de busca — se o Gemini cair, a análise perde a investigação.">🔎 busca via Gemini</span>`
              : '';
          }
          // sem Gemini: aí sim é alerta
          return openaiSemBusca
            ? `<span class="v4-chip v4-chip-warn" title="Gemini fora do ar e o modelo da OpenAI (${esc(v4Health.openai.modelo || '?')}) não busca na web. A análise vai rodar só com o conhecimento do modelo e os dados da Receita.">⚠ SEM busca web</span>`
            : `<span class="v4-chip v4-chip-warn" title="Gemini fora do ar">⚠ sem Gemini</span>`;
        })() +
        `<button class="v4-health-refresh" id="v4-hr" title="Recheck">↻</button>`;
      s.querySelectorAll('[data-chip]').forEach(el => el.addEventListener('click', () => {
        const w = el.getAttribute('data-chip');
        if (w === 'gemini') askGeminiKey();
        else if (w === 'openai') getOpenAIKey();
        else if (w === 'outbound') getOutboundToken();
        refreshHealth(true);
      }));
    }
    const b = document.getElementById('v4-hr');
    if (b) b.onclick = () => refreshHealth(true, true);
  }
  function updateFabBadge() {
    let b = document.getElementById('v4-fab-badge');
    if (!b) { b = document.createElement('span'); b.id = 'v4-fab-badge'; fab.appendChild(b); }
    if (!v4Health) { b.style.background = '#777'; fab.title = 'integrações não verificadas'; return; }
    if (criticalIssue()) { b.style.background = '#CC1414'; fab.title = `🔴 crítico\n\n${healthSummary()}`; }
    else if (isStale()) { b.style.background = '#D97706'; fab.title = `⚠ verificação antiga (${hhmm(v4HealthAt)})`; }
    else { b.style.background = '#16A34A'; fab.title = `✅ OK · ${hhmm(v4HealthAt)}`; }
  }

  // ═══════════════════════════════════════════════════════════════
  // AÇÕES PRINCIPAIS
  // ═══════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════
  // AUTO-SELEÇÃO (v8.11) — marcar o texto já dispara a análise
  // ═══════════════════════════════════════════════════════════════
  const ROTULOS_LEAD = [
    /faturamento/i, /segmento/i, /canal/i, /tipo\s+de\s+produto/i,
    /nome\s+do\s+respons/i, /e-?mail/i, /telefone/i, /urg[êe]ncia/i,
    /documento\s+da\s+empresa/i, /data\s+de\s+cria/i, /cidade/i,
  ];

  // Marcadores que só existem na UI do próprio script — se aparecerem,
  // a seleção veio do painel do V4, não da página do LeadBroker.
  const MARCADORES_PAINEL = [
    /valor endere[çc][áa]vel/i, /pilar prov[áa]vel/i, /momento [123]/i,
    /lead j[áa] analisado/i, /dossi[êe] pro sdr/i, /homônimos que N[ÃA]O/i,
    /v4 lead analyzer/i, /adicionar lead [àa] fila/i, /arrematei/i,
    /empresa existe/i, /ramo real/i, /dados oficiais/i, /contradi[çc][õo]es e red flags/i,
    /fora do icp core/i, /evid[êe]ncia (baixa|m[ée]dia|alta)/i,
  ];

  function selecaoDentroDoPainel() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    let n = sel.getRangeAt(0).commonAncestorContainer;
    if (n.nodeType === 3) n = n.parentNode;
    while (n && n !== document.body) {
      if (n.id === 'v4-overlay' || n.id === 'v4-hist-overlay' || n.id === 'v4-panel'
          || n.id === 'v4-hist-panel' || n.id === 'v4-fab') return true;
      n = n.parentNode;
    }
    return false;
  }

  // v9.34: devolve o motivo da recusa. Antes retornava só true/false e a
  // seleção era descartada em silêncio — a pessoa marcava o texto e nada
  // acontecia, sem nenhuma pista do porquê.
  const MIN_ROTULOS = 2;   // era 3; 2 já distingue lead de texto solto

  function avaliarSelecao(texto) {
    if (!texto) return { ok: false, motivo: 'nada selecionado' };

    // v16.2: Cmd+A seleciona a página inteira, incluindo o painel do V4.
    // Se o bloco do lead está lá dentro, vale — isola e segue.
    const temPainelLead = /(?:^|\n)[ \t]*Faturamento[ \t]*:/i.test(texto)
      && /(?:^|\n)[ \t]*(Segmento|Nome do respons[áa]vel|Tipo de produto)[ \t]*:/i.test(texto);

    if (texto.length < 30) {
      return { ok: false, motivo: `seleção muito curta (${texto.length} caracteres, mínimo 30)` };
    }
    if (!temPainelLead) {
      const marcador = MARCADORES_PAINEL.find(re => re.test(texto));
      if (marcador) {
        return { ok: false, motivo: 'esse texto é do próprio painel do V4, não da página do lead' };
      }
    }
    const achados = ROTULOS_LEAD.filter(re => re.test(texto));
    if (achados.length < MIN_ROTULOS) {
      return {
        ok: false,
        motivo: `não parece um lead — achei ${achados.length} de ${MIN_ROTULOS} campos necessários. `
              + 'Marque o bloco todo (empresa, faturamento, segmento, canal, responsável, e-mail)',
        hits: achados.length,
      };
    }
    return { ok: true, hits: achados.length, paginaInteira: temPainelLead && texto.length > 3000 };
  }

  function pareceLead(texto) { return avaliarSelecao(texto).ok; }



  let autoTimer = null;
  let ultimoAuto = '';

  // dica flutuante acima do botão vermelho
  let dicaTimer = null;
  function mostrarDica(html, ms) {
    let el = document.getElementById('v4-dica');
    if (!el) {
      el = document.createElement('div');
      el.id = 'v4-dica';
      document.body.appendChild(el);
    }
    const r = fab.getBoundingClientRect();
    el.style.right = Math.max(12, window.innerWidth - r.right) + 'px';
    el.style.bottom = (window.innerHeight - r.top + 10) + 'px';
    el.innerHTML = html;
    el.classList.add('on');
    clearTimeout(dicaTimer);
    dicaTimer = setTimeout(() => el.classList.remove('on'), ms || 4500);
  }

  function autoAnalisarSelecao() {
    if (GM_getValue('v4_auto_selecao', '1') !== '1') return;
    if (selecaoDentroDoPainel()) return;   // seleção no painel do V4 não é lead
    const sel = (window.getSelection().toString() || '').trim();
    if (!sel || sel === ultimoAuto) return;

    const av = avaliarSelecao(sel);
    if (!av.ok) {
      // só avisa em seleção com algum tamanho — não polui quando é clique solto
      if (sel.length >= 15) {
        console.warn('[V4] seleção ignorada:', av.motivo);
        mostrarDica(`<b>Não analisei essa seleção</b><br>${esc(av.motivo)}.`);
      }
      return;
    }
    if (duplicataNaFila(sel)) return;

    const antes = analisadoAntes(sel);
    if (antes) {
      ultimoAuto = sel;
      window.getSelection().removeAllRanges();
      openPanel();
      avisarJaAnalisado(sel, antes);
      return;
    }

    // v14.7: seleção parcial NÃO bloqueia. No leilão há segundos, e mesmo com só
    // o nome da empresa a investigação acha site, Instagram e ramo — informação
    // útil. Antes eu recusava, o que era pior que analisar com dado incompleto.
    // O aviso aparece, a análise segue.
    const pobre = selecaoPobre(preExtract(sel));
    if (pobre) {
      console.warn('[V4] seleção parcial:', pobre.falta);
      mostrarDica(`<b>Analisando, mas faltou dado</b><br>${esc(pobre.texto)}.<br>`
        + '<span style="opacity:.75">Vou investigar com o que tem. Pra melhorar, '
        + 'tente Shift+clique no fim do bloco em vez de arrastar.</span>', 6000);
    }

    // reserva ANTES do await — senão um segundo disparo passa pela checagem
    if (!reservar(sel)) return;
    ultimoAuto = sel;
    window.getSelection().removeAllRanges();
    (async () => {
      try {
        const ok = await prepararAnalise();
        if (!ok) { ultimoAuto = ''; liberar(sel); return; }
        openPanel();
        addLead(sel);
      } catch (e) {
        console.warn('[V4] auto:', e);
        liberar(sel);
      }
    })();
  }

  // v9.11: o rótulo do botão diz o que ele vai fazer, pra não haver surpresa
  function atualizarRotuloFab() {
    const el = document.getElementById('v4-fab-label');
    if (!el) return;
    const sel = selecaoDentroDoPainel() ? '' : (window.getSelection().toString() || '').trim();
    if (sel && pareceLead(sel)) {
      el.textContent = 'Analisar seleção';
      fab.style.background = '#CC1414';
    } else if (queue.length) {
      el.textContent = `Ver análises (${queue.length})`;
      fab.style.background = '#8B1010';
    } else {
      el.textContent = 'Analisar Lead';
      fab.style.background = '#CC1414';
    }
  }

  // debounce: espera a seleção estabilizar antes de disparar.
  // v14.10: 400ms era pouco. Soltar o mouse no meio de um arraste longo (pra
  // rolar a página, por exemplo) disparava a análise do pedaço. Agora espera
  // mais e confere se a seleção parou de crescer.
  let ultimoTam = 0;
  function agendarAuto() {
    clearTimeout(autoTimer);
    atualizarRotuloFab();
    const tam = (window.getSelection().toString() || '').length;
    const crescendo = tam > ultimoTam;
    ultimoTam = tam;
    autoTimer = setTimeout(() => {
      const agora = (window.getSelection().toString() || '').length;
      if (agora > tam) { agendarAuto(); return; }   // ainda crescendo, espera mais
      autoAnalisarSelecao();
    }, crescendo ? 900 : 500);
  }
  // v9.36: atalho de emergência. Se o painel sumir por qualquer motivo,
  // Ctrl+Shift+V (⌃⇧V no Mac) limpa as preferências de layout e reabre.
  document.addEventListener('keydown', e => {
    if (!e.ctrlKey || !e.shiftKey || e.key.toLowerCase() !== 'v') return;
    e.preventDefault();
    console.warn('[V4] reset de emergência acionado');
    GM_setValue('v4_geo', '');
    GM_setValue('v4_rodape_w', '');
    GM_setValue('v4_rodape_h', '');
    GM_setValue('v4_layout', 'rodape');
    GM_setValue('v4_altura_idx', '1');
    overlay.classList.add('active');
    try { aplicarLayout(); } catch (err) { layoutEmergencia(); }
    setTimeout(verificarVisibilidade, 60);
    mostrarDica('<b>Painel restaurado</b><br>Layout voltou ao padrão (rodapé, 1/5 da tela).', 3000);
  }, true);

  document.addEventListener('mouseup', agendarAuto, true);
  document.addEventListener('selectionchange', () => setTimeout(atualizarRotuloFab, 50));
  document.addEventListener('keyup', e => { if (e.shiftKey || e.key === 'a') agendarAuto(); }, true);

  // Garante chaves e roda o health funcional do dia. Retorna false se deve abortar.
  async function prepararAnalise() {
    if (!GM_getValue('v4_openai_key', '')) {
      const temCodigo = confirm(
        '🔑 Primeira vez por aqui.\n\n' +
        'Você recebeu um CÓDIGO DE CONFIGURAÇÃO da Re (começa com V4CFG1.)?\n\n' +
        'OK = colar o código\n' +
        'Cancelar = configurar chave por chave'
      );
      if (temCodigo) {
        const cod = prompt('Cole o código de configuração:');
        if (cod) {
          const r = aplicarCodigoSetup(cod);
          if (r.ok) {
            alert('✅ Configurado! Já pode analisar leads.');
            refreshHealth(true, true);
          } else {
            alert('❌ ' + r.erro + '\n\nVamos configurar manualmente então.');
          }
        }
      }
    }
    if (!getOpenAIKey()) return false;
    if (!GM_getValue('v4_outbound_token', '') && !GM_getValue('v4_ob_asked', '')) {
      getOutboundToken();
      GM_setValue('v4_ob_asked', '1');
    }
    if (isStale()) {
      const orig = fab.innerHTML;
      fab.innerHTML = '<span class="v4-spinner"></span><span>Verificando…</span>';
      fab.style.pointerEvents = 'none';
      try { await refreshHealth(true, true); } catch (e) { console.warn('[V4] health:', e); }
      fab.innerHTML = orig;
      fab.style.pointerEvents = '';
      if (criticalIssue()) {
        if (!confirm(`⚠️ OpenAI com problema\n\n${healthSummary()}\n\nA análise pode falhar. Continuar?`)) {
          openPanel(); return false;
        }
      }
    }
    return true;
  }

  // Botão / FAB: usa a seleção da página; sem seleção, abre o prompt do navegador
  // v9.11: o 🔴 flutuante virou "abrir OU analisar".
  // Antes, sem seleção ele abria um prompt() de colagem — e se você cancelasse,
  // o painel não abria. Não havia como voltar pra ver as análises já feitas sem
  // marcar outro lead, o que gastava API à toa.
  async function promptForLead() {
    const sel = selecaoDentroDoPainel() ? '' : window.getSelection().toString().trim();
    if (!sel) { openPanel(); return; }   // sem seleção → só reabre o painel
    ultimoAuto = sel;
    await adicionarLead(sel);
  }

  // Colagem manual — botão de dentro do painel
  async function colarLeadManual() {
    const t = prompt('Cole os dados do lead (⌘V) e dê OK:');
    if (!t || !t.trim()) return;
    await adicionarLead(t.trim());
  }

  async function adicionarLead(textoCru) {
    // v19.6: a reposição de quebras estava só no addLead, no FIM do fluxo —
    // mas a validação que rejeita ("não consegui identificar empresa") acontece
    // antes. Texto colado numa linha só era descartado sem nunca chegar lá.
    const texto = reporQuebras(textoCru);

    if (duplicataNaFila(texto)) {
      openPanel();
      const ja = acharNaFila(texto);
      if (ja && ja.card) {
        ja.card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        piscarCard(ja.card);
        avisarMesmoLead(ja, texto);
      }
      return;
    }
    const antes = analisadoAntes(texto);
    if (antes) {
      openPanel();
      avisarJaAnalisado(texto, antes);
      return;
    }
    const ok = await prepararAnalise();
    if (!ok) return;
    if (window.getSelection) window.getSelection().removeAllRanges();
    openPanel();
    addLead(texto);
  }

  function clearQueue() {
    if (!queue.length) return;
    if (!confirm(`Limpar ${queue.length} card(s) da tela?\n\n(o histórico é preservado)`)) return;
    queue.forEach(q => {
      if (q.timer) clearInterval(q.timer);
      if (q.card && q.card.parentNode) q.card.parentNode.removeChild(q.card);
    });
    queue.length = 0; queueId = 0; processing = 0;
    reservados.clear();
    idsReservados.clear();
    selecionado = null;
    pararTimerProd();
    if (railEl) railEl.innerHTML = '';
    ultimoAuto = '';
    updateCount();
  }

  // ═══════════════════════════════════════════════════════════════
  // HISTÓRICO — UI
  // ═══════════════════════════════════════════════════════════════
  let hFilter = 'todos', hSearch = '';

  function openHist() { histOverlay.classList.add('active'); renderHist(); }
  function closeHist() { histOverlay.classList.remove('active'); }

  function histColor(m) {
    if (m.isConcorrente) return 'vermelho';
    if (m.empresaExiste === 'nao') return 'vermelho';
    if (m.empresaExiste === 'sim' && (m.decisor === 'sim' || m.socioQsa)) return 'verde';
    return 'amarelo';
  }

  function renderHist() {
    const items = listHistory();
    document.getElementById('v4-hist-count').textContent = items.length;
    const body = document.getElementById('v4-hist-body');
    const info = document.getElementById('v4-hist-info');

    const q = hSearch.toLowerCase().trim();
    const filtered = items.filter(it => {
      const m = it.meta;
      if (hFilter === 'concorrente' && !m.isConcorrente) return false;
      if (hFilter === 'comprei' && m.outcome !== 'comprei') return false;
      if (hFilter === 'cliente' && m.outcome !== 'cliente') return false;
      if (['verde', 'amarelo', 'vermelho'].includes(hFilter) && histColor(m) !== hFilter) return false;
      if (q) {
        const blob = `${m.empresa || ''} ${m.contato || ''} ${m.cidade || ''} ${m.segmento || ''} ${m.ramoReal || ''} ${m.decisorPapel || ''}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });

    const st = items.reduce((a, it) => {
      const c = histColor(it.meta);
      a[c] = (a[c] || 0) + 1;
      if (it.meta.isConcorrente) a.conc = (a.conc || 0) + 1;
      if (it.meta.outcome === 'comprei') a.comprei = (a.comprei || 0) + 1;
      if (it.meta.outcome === 'cliente') a.cliente = (a.cliente || 0) + 1;
      return a;
    }, {});
    info.innerHTML = items.length
      ? `${items.length} leads · 🟢 ${st.verde || 0} · 🟡 ${st.amarelo || 0} · 🔴 ${st.vermelho || 0} · 🚨 ${st.conc || 0} conc · ${st.comprei || 0} arrematados · ${st.cliente || 0} clientes`
      : '— retenção 30 dias';

    if (!items.length) {
      body.innerHTML = `<div id="v4-hist-empty"><div id="v4-hist-empty-icon">📚</div>
        <div id="v4-hist-empty-title">Histórico vazio</div>
        <div id="v4-hist-empty-sub">Análises ficam salvas por 30 dias.<br>Marque o resultado nos cards pra calibrar o script.</div></div>`;
      return;
    }
    if (!filtered.length) {
      body.innerHTML = `<div id="v4-hist-empty"><div id="v4-hist-empty-icon">🔍</div>
        <div id="v4-hist-empty-title">Nenhum resultado</div>
        <div id="v4-hist-empty-sub">Ajuste busca ou filtros.</div></div>`;
      return;
    }

    body.innerHTML = filtered.map(it => {
      const m = it.meta;
      const cor = m.farol
        ? (m.farol === 'GO' ? 'verde' : m.farol === 'STOP' ? 'vermelho'
          : m.farol === 'CONCORRENTE' ? 'concorrente' : 'amarelo')
        : histColor(m);   // leads antigos
      // v16.8: os ícones vêm dos MESMOS boxes que o card mostrou. Antes o
      // histórico recalculava a partir dos campos brutos e divergia — o
      // ATLÂNTICOS GRILL aparecia com três verdes no histórico e decisor
      // amarelo no card.
      const ico = c => c === 'verde' ? '✅' : c === 'vermelho' ? '❌'
                     : c === 'concorrente' ? '🚨' : '⚠️';
      const ck = m.boxes
        ? [ico(m.boxes.concorrente), ico(m.boxes.empresa), ico(m.boxes.decisor), ico(m.boxes.margem)].join('')
        : [   // leads antigos, gravados antes da v16.8
            m.isConcorrente ? '🚨' : m.isConcorrente === false ? '✅' : '⚠️',
            m.empresaExiste === 'sim' ? '✅' : m.empresaExiste === 'parcial' ? '⚠️' : '❌',
            (m.socioQsa || m.decisor === 'sim') ? '✅' : m.decisor === 'parcial' ? '⚠️' : '❌',
          ].join('');
      const sub = [m.contato, m.cidade, m.tier, m.ramoReal, m.pilar].filter(Boolean).join(' · ');
      const out = m.outcome ? `<span class="v4-hout v4-hout-${m.outcome}">${m.outcome === 'comprei' ? 'arrematei' : m.outcome === 'cliente' ? 'cliente' : 'passei'}</span>` : '';
      return `<div class="v4-hrow ${cor}" data-k="${it.key}">
        <div class="v4-hdate">${fmtHistDate(it.timestamp)}</div>
        <div class="v4-hmain">
          <div class="v4-hname">${esc(m.empresa || '(sem nome)')}${m.socioQsa ? (m.boxes && m.boxes.decisor !== 'verde'
            ? ' <span class="v4-badge-socio" style="background:linear-gradient(135deg,#D97706,#B45309);color:#FEF3C7">💎 a confirmar</span>'
            : ' <span class="v4-badge-socio">💎 sócio</span>') : ''}${out}</div>
          <div class="v4-hsub">${esc(sub || '—')}</div>
        </div>
        <div class="v4-hchecks" title="concorrente · empresa · decisor · margem">${ck}</div>
      </div>`;
    }).join('');

    body.querySelectorAll('.v4-hrow').forEach(r => r.addEventListener('click', () => {
      const raw = GM_getValue(r.getAttribute('data-k'), '');
      if (!raw) return;
      try {
        const d = JSON.parse(raw);
        if (d.rawText) { closeHist(); openPanel(); addLead(d.rawText); }
      } catch (e) { }
    }));
  }

  function csvEsc(v) {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n;]/.test(s) ? `"${s}"` : s;
  }
  function stamp() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function download(content, name, mime) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }
  // v14.8: o CSV ainda tinha as colunas do cálculo antigo (pilar_sugerido) e
  // faltava o principal: QUEM analisou, o farol e a leitura de margem.
  function exportCSV() {
    const items = listHistory();
    if (!items.length) { alert('Histórico vazio.'); return; }
    const H = ['data', 'usuario', 'farol', 'empresa', 'contato', 'cidade', 'uf', 'faturamento',
      'canal', 'segmento_declarado', 'ramo_real', 'cnae', 'cnpj',
      'margem_bucket', 'margem_faixa',
      'concorrente', 'empresa_existe', 'decisor', 'decisor_papel', 'socio_qsa', 'resultado'];
    const rows = items.map(it => {
      const m = it.meta || {};
      return [
        new Date(it.timestamp).toISOString(),
        m.usuario || nomeUsuario(),
        m.farol || '',
        m.empresa, m.contato, m.cidade, m.estado, m.faturamento || m.tier,
        m.canal, m.segmento, m.ramoReal, m.cnae || '', m.cnpj,
        m.margemBucket || '', m.margemFaixa || '',
        m.isConcorrente ? 'sim' : m.isConcorrente === false ? 'nao' : '?',
        m.empresaExiste, m.decisor, m.decisorPapel, m.socioQsa ? 'sim' : 'nao',
        m.outcome,
      ].map(csvEsc).join(',');
    });
    download('\uFEFF' + H.join(',') + '\n' + rows.join('\n'), `v4-leads-${stamp()}.csv`, 'text/csv;charset=utf-8');
  }
  function exportJSON() {
    const items = listHistory();
    if (!items.length) { alert('Histórico vazio.'); return; }
    download(JSON.stringify(items, null, 2), `v4-leads-${stamp()}.json`, 'application/json');
  }

  // ═══════════════════════════════════════════════════════════════
  // EVENTS
  // ═══════════════════════════════════════════════════════════════
  // v9.35: o listener do botão é o PRIMEIRO de todos e tem rede de proteção.
  // Sintoma que motivou isso: botão aparecia, cursor virava mão, clique não
  // fazia nada — porque um erro em outro listener abortava o resto do init.
  let initOk = true;
  const erroInit = [];

  function protegido(nome, fn) {
    return function (...a) {
      try { return fn.apply(this, a); }
      catch (e) {
        console.error(`[V4] erro em ${nome}:`, e);
        alert(`⚠️ Erro em "${nome}"\n\n${e.message}\n\nMande um print pra Re. `
            + 'O resto da ferramenta continua funcionando.');
      }
    };
  }

  function conectar(id, evento, fn, nome) {
    const el = document.getElementById(id);
    if (!el) {
      initOk = false;
      erroInit.push(`elemento #${id} não existe`);
      console.error(`[V4] #${id} não encontrado — botão "${nome || id}" ficará inativo`);
      return;
    }
    el.addEventListener(evento, protegido(nome || id, fn));
  }

  fab.addEventListener('click', protegido('botão flutuante', promptForLead));
  conectar('v4-header', 'mousedown', iniciarArraste);
  conectar('v4-resize', 'mousedown', iniciarResize);
  conectar('v4-resize-tr', 'mousedown', iniciarResizeRodape);
  // v9.23: os botões técnicos ficam escondidos atrás de "⚙ Config".
  // Menos chance de um SDR mexer em chave ou modelo por engano no meio do leilão.
  conectar('v4-config', 'click', () => {
    setTimeout(aplicarModoTime, 30);   // v23.0
    const t = document.getElementById('v4-tec');
    const b = document.getElementById('v4-config');
    const on = t.style.display !== 'none';
    t.style.display = on ? 'none' : 'inline-flex';
    b.style.borderColor = on ? '' : '#444';
    b.style.color = on ? '' : '#BBB';
  });

  conectar('v4-layout-btn', 'click', ciclarLayout);
  conectar('v4-altura', 'click', ciclarAltura);
  conectar('v4-voltar', 'click', voltarParaFaixa);
  window.addEventListener('resize', () => {
    if (layout() === 'janela' && overlay.classList.contains('active')) restaurarGeometria();
  });
  conectar('v4-close', 'click', closePanel);
  conectar('v4-add-btn', 'click', colarLeadManual);
  conectar('v4-clear-queue', 'click', clearQueue);
  conectar('v4-open-hist', 'click', () => { openHist(); setTimeout(aplicarModoTime, 40); });   // v23.0
  conectar('v4-hist-close', 'click', closeHist);

  conectar('v4-add-gemini', 'click', () => {
    if (GM_getValue('v4_gemini_key', '') && !confirm('Já existe chave Gemini. Substituir?')) return;
    if (askGeminiKey()) { alert('✅ Gemini adicionada — próxima análise roda em paralelo com o GPT.'); refreshHealth(true); }
  });
  function renderAutoBtn() {
    const b = document.getElementById('v4-auto');
    if (!b) return;
    const on = GM_getValue('v4_auto_selecao', '1') === '1';
    b.textContent = on ? '⚡ Auto ON' : '⚡ Auto OFF';
    b.style.borderColor = on ? '#16A34A50' : '#2A2A2A';
    b.style.color = on ? '#4ADE80' : '#666';
    b.title = on
      ? 'Marcar o texto do lead na página já dispara a análise. Clique pra desligar.'
      : 'Auto-análise desligada — use a caixa ou o botão flutuante. Clique pra ligar.';
  }
  conectar('v4-setup', 'click', () => {
    const jaTem = !!GM_getValue('v4_openai_key', '');
    const podeGerar = jaTem && souDono();
    const opcao = prompt(
      '🔑 CHAVES DE API\n\n' +
      'Digite o NÚMERO da opção e clique OK:\n\n' +
      '  1  →  RECEBI um código e quero colar\n' +
      (podeGerar ? '  2  →  QUERO GERAR o código pra mandar pro time\n' : '') +
      '  3  →  Configurar chave por chave (OpenAI, Gemini, OutboundPro)\n' +
      (podeGerar ? '  4  →  Histórico central (Google Sheets) e seu nome\n' : '  4  →  Mudar meu nome no histórico\n') + '\n' +
      (podeGerar ? 'Para distribuir ao time: digite 2\n' : ''),
      '1'
    );
    if (opcao === null) return;

    if (opcao.trim() === '1') {
      const cod = prompt(
        'Cole o código de configuração:\n\n' +
        '(começa com V4CFG1. — a Re envia por canal privado)'
      );
      if (!cod) return;
      const r = aplicarCodigoSetup(cod);
      if (!r.ok) { alert('❌ ' + r.erro); return; }
      alert(
        '✅ Configurado!\n\n' +
        'OpenAI: ok\n' +
        'Gemini: ' + (r.temGemini ? 'ok' : 'não incluído') + '\n' +
        'OutboundPro: ' + (r.temOutbound ? 'ok' : 'não incluído') + '\n' +
        'Histórico da unidade: ' + (r.temSheet ? 'ativo' : 'não configurado') + '\n\n' +
        'Código gerado em ' + r.em + '.\nJá pode analisar leads.'
      );
      refreshHealth(true, true);
      return;
    }

    if (opcao.trim() === '2') {
      const cod = gerarCodigoSetup();
      if (!cod) return;
      navigator.clipboard.writeText(cod).then(() => {
        alert(
          '✅ Código copiado para a área de transferência.\n\n' +
          '⚠️ TRATE COMO SENHA:\n' +
          '• mande por canal privado (DM, gerenciador de senhas)\n' +
          '• NUNCA coloque no GitHub ou em canal público\n' +
          '• quem tiver o código gasta na SUA conta\n\n' +
          'Se vazar: revogue a chave na OpenAI e gere outra.'
        );
      }).catch(() => {
        prompt('Copie o código abaixo (⌘C) e envie por canal privado:', cod);
      });
      return;
    }

    if (opcao.trim() === '4') {
      const dono = souDono();
      if (dono) {
        const atual = GM_getValue('v4_sheet_url', '');
        const u = prompt(
          '📊 HISTÓRICO CENTRAL DA UNIDADE\n\n'
          + 'Cole a URL do app do Google Apps Script (termina em /exec).\n'
          + 'Todas as análises do time passam a cair numa planilha só,\n'
          + 'identificadas por usuário.\n\n'
          + 'Deixe em branco e clique OK para desligar.\n\n'
          + 'Depois de configurar, gere um código novo (opção 2) para o time.',
          atual
        );
        if (u === null) return;
        const url = u.trim();
        if (url && !/^https:\/\/script\.google(usercontent)?\.com\/.*\/exec/.test(url)) {
          alert('URL inválida.\n\nDeve ser https://script.google.com/macros/s/.../exec');
          return;
        }
        GM_setValue('v4_sheet_url', url);
        if (url) {
          pedirNomeUsuario(true);
          alert('✅ Histórico central ligado.\n\nGere um código novo (opção 2) e redistribua '
              + 'pro time — a URL viaja dentro dele.');
        } else {
          alert('Histórico central desligado.');
        }
      } else {
        const n = pedirNomeUsuario(true);
        alert(n ? `✅ Você aparece como "${n}" no histórico.` : 'Nome não alterado.');
      }
      return;
    }

    if (opcao.trim() === '3') {
      marcarDono();
      getOpenAIKey();
      if (confirm('Adicionar chave do Gemini? (recomendado — deixa mais rápido)')) askGeminiKey();
      if (confirm('Adicionar token do OutboundPro? (opcional)')) getOutboundToken();
      if (confirm('Adicionar chave do Serper? (busca crua — acha o CNPJ em ~1s, antes da IA)')) askSerperKey();
      if (confirm('Configurar envio automático pro GHL? (lead comprado vai pro CRM com a análise)')) askGhlKeys();
      refreshHealth(true, true);
      return;
    }

    alert('Opção inválida.');
  });

  conectar('v4-auto', 'click', () => {
    const on = GM_getValue('v4_auto_selecao', '1') === '1';
    GM_setValue('v4_auto_selecao', on ? '0' : '1');
    ultimoAuto = '';
    renderAutoBtn();
  });
  renderAutoBtn();

  function renderAutoM2Btn() {
    const b = document.getElementById('v4-auto-m2');
    if (!b) return;
    const on = autoM2Ligado();
    b.textContent = on ? '🔍 Auto-M2 ON' : '🔍 Auto-M2 OFF';
    b.style.borderColor = on ? '#16A34A60' : '#3A3A3A';
    b.style.color = on ? '#86EFAC' : '#9A9A9A';
    b.title = on
      ? 'O Momento 2 roda sozinho quando há box amarelo ou vermelho. Clique pra desligar.'
      : 'O Momento 2 só roda quando você clicar. Clique pra ligar o automático.';
  }

  function renderRaceBtn() {
    const b = document.getElementById('v4-race');
    if (!b) return;
    const on = modoRace();
    b.textContent = on ? '⚡⚡ Race ON' : '⚡⚡ Race OFF';
    b.style.borderColor = on ? '#D9770650' : '#2A2A2A';
    b.style.color = on ? '#FBBF24' : '#666';
    b.title = on
      ? 'Gemini e OpenAI em paralelo: ~2-3s mais rápido, mas paga as DUAS chamadas (~6x o custo). Clique pra desligar.'
      : 'Gemini primeiro, OpenAI só se falhar. Modo econômico (~85% menos custo). Clique pra ligar o paralelo.';
  }
  // ═══ PAINEL DE CONSUMO ═══
  function abrirConsumo() {
    const p = precos();
    const meses = mesesComUso();
    const linhas = meses.slice(0, 6).map(m => {
      const c = lerConsumo(m);
      const k = calcularCusto(c, p);
      const tokTotal = c.gem.in + c.gem.out + c.gpt.in + c.gpt.out;
      const porLead = c.leads ? k.totalBrl / c.leads : 0;
      return `${m}  ${String(c.leads).padStart(5)} leads  ${String(tokTotal.toLocaleString('pt-BR')).padStart(12)} tok  `
           + `R$ ${k.totalBrl.toFixed(2).padStart(8)}  (R$ ${porLead.toFixed(4)}/lead)`;
    }).join('\n');

    const c = lerConsumo();
    const k = calcularCusto(c, p);
    const franqRestante = Math.max(0, p.busca_franquia - c.gem.buscas);

    const txt =
      `📊 CONSUMO · ${mesAtual()}\n` +
      '═'.repeat(52) + '\n\n' +
      `Leads analisados (momento 1):  ${c.leads}\n` +
      `Momento 2 rodado:              ${c.m2}\n` +
      `Dossiês gerados (momento 3):   ${c.m3}\n\n` +
      `GEMINI  ${c.gem.calls} chamadas\n` +
      `  entrada ${c.gem.in.toLocaleString('pt-BR')} tok · saída ${c.gem.out.toLocaleString('pt-BR')} tok\n` +
      `  buscas cobráveis: ${c.gem.buscas}  (franquia: ${p.busca_franquia}, restam ${franqRestante})\n` +
      `  custo tokens: R$ ${(k.gemTok * p.usd).toFixed(2)}\n\n` +
      `OPENAI  ${c.gpt.calls} chamadas\n` +
      `  entrada ${c.gpt.in.toLocaleString('pt-BR')} tok · saída ${c.gpt.out.toLocaleString('pt-BR')} tok\n` +
      `  custo tokens: R$ ${(k.gptTok * p.usd).toFixed(2)}\n\n` +
      `BUSCA GOOGLE\n` +
      `  ${k.cobradas} cobrada(s) · R$ ${(k.busca * p.usd).toFixed(2)}` +
      (k.cobradas === 0 ? '  (dentro da franquia)' : '') + '\n\n' +
      '─'.repeat(52) + '\n' +
      `TOTAL DO MÊS:  US$ ${k.totalUsd.toFixed(2)}  =  R$ ${k.totalBrl.toFixed(2)}\n` +
      (c.leads ? `POR LEAD:      R$ ${(k.totalBrl / c.leads).toFixed(4)}\n` : '') +
      (() => {
        const d = new Date();
        const diaHoje = d.getDate();
        const diasMes = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        if (!c.leads || diaHoje < 3) return '';
        const proj = k.totalBrl * (diasMes / diaHoje);
        return `PROJEÇÃO DO MÊS: R$ ${proj.toFixed(2)}  (no ritmo de ${(c.leads / diaHoje).toFixed(1)} leads/dia)\n`;
      })() +
      '─'.repeat(52) + '\n\n' +
      (linhas ? `HISTÓRICO\n${linhas}\n\n` : '') +
      `PREÇOS (US$/1M tokens) · ${GM_getValue('v4_precos', '') ? 'editados por você' : PRECO_FONTE}\n` +
      `  Gemini 2.5 Flash   entrada ${p.gem_in}   saída ${p.gem_out}\n` +
      `  OpenAI (ref. 5.6)  entrada ${p.gpt_in}   saída ${p.gpt_out}\n` +
      `  Busca Google       US$ ${p.busca_mil}/1.000 após ${p.busca_franquia} grátis\n` +
      `  Dólar              R$ ${p.usd}\n\n` +
      `Referência: Gemini 2.5 cobra grounding por PROMPT.\n` +
      `Se migrar pro Gemini 3.x, passa a cobrar por QUERY —\n` +
      `este mês seriam ${c.gem.queries} queries em vez de ${c.gem.buscas} prompts.\n\n` +
      'Digite "precos" para ajustar · "zerar" para limpar o mês · Enter para fechar';

    const acao = prompt(txt, '');
    if (acao === null) return;
    const a = acao.trim().toLowerCase();

    if (a === 'precos' || a === 'preços') {
      const novo = prompt(
        'Ajustar preços — formato:\n' +
        'dolar, gemini_entrada, gemini_saida, openai_entrada, openai_saida, franquia, busca_por_mil\n\n' +
        'Valores em US$ por 1 milhão de tokens (busca em US$ por 1.000):',
        `${p.usd}, ${p.gem_in}, ${p.gem_out}, ${p.gpt_in}, ${p.gpt_out}, ${p.busca_franquia}, ${p.busca_mil}`
      );
      if (!novo) return;
      const v = novo.split(',').map(x => parseFloat(x.trim().replace(',', '.')));
      if (v.length < 7 || v.some(isNaN)) { alert('Formato inválido — precisa de 7 números.'); return; }
      GM_setValue('v4_precos', JSON.stringify({
        usd: v[0], gem_in: v[1], gem_out: v[2], gpt_in: v[3], gpt_out: v[4],
        busca_franquia: v[5], busca_mil: v[6],
      }));
      alert('Preços atualizados.');
      abrirConsumo();
      return;
    }

    if (a === 'zerar') {
      if (!confirm(`Zerar o consumo de ${mesAtual()}?\n\nO histórico dos meses anteriores é mantido.`)) return;
      GM_setValue('v4_uso_' + mesAtual(), '');
      alert('Consumo do mês zerado.');
      return;
    }
  }

  // ═══ DIAGNÓSTICO ═══
  // v9.34: quando "nada acontece", isso diz exatamente o que está faltando.
  // ═══════════════════════════════════════════════════════════════
  // TESTE REAL DAS APIs (v19.1)
  // O diagnóstico anterior só conferia se a chave existia — por isso dizia
  // "tudo ok" com a OpenAI em "?" e com o Gemini fazendo zero buscas.
  //
  // Este faz a chamada de verdade, com a mesma configuração da análise, e
  // pergunta algo que SÓ pode ser respondido buscando na web.
  // ═══════════════════════════════════════════════════════════════
  function testarBuscaReal() {
    const key = GM_getValue('v4_gemini_key', '');
    if (!key) return Promise.resolve({ erro: 'sem chave do Gemini' });

    const modelo = GM_getValue('v4_gemini_model', 'gemini-2.5-flash');
    // pergunta verificável: uma empresa real, com CNPJ público
    const pergunta = 'Qual o CNPJ da empresa Serja Industria de Moveis e Marcenaria, '
      + 'em Sao Paulo? Responda apenas o numero, ou "nao encontrei".';

    return new Promise(resolve => {
      const t0 = Date.now();
      GM_xmlhttpRequest({
        method: 'POST',
        url: `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${encodeURIComponent(key)}`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: pergunta }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 8192,
            thinkingConfig: { thinkingBudget: 1024 },
          },
          tools: [{ google_search: {} }],
        }),
        timeout: 25000,
        onload(r) {
          const ms = Date.now() - t0;
          try {
            const d = JSON.parse(r.responseText);
            if (d.error) return resolve({ erro: d.error.message || 'erro', ms });
            const cand = d.candidates?.[0];
            const texto = (cand?.content?.parts || []).map(p => p.text).filter(Boolean).join(' ').trim();
            const gm = cand?.groundingMetadata || {};
            const queries = gm.webSearchQueries || [];
            const chunks = (gm.groundingChunks || []).length;
            resolve({
              ms, texto: texto.slice(0, 160),
              queries: queries.length, exemplos: queries.slice(0, 3),
              chunks,
              finish: cand?.finishReason || '',
              achou: /61\.?249\.?466|61249466/.test(texto),
            });
          } catch (e) { resolve({ erro: e.message, ms }); }
        },
        onerror() { resolve({ erro: 'rede' }); },
        ontimeout() { resolve({ erro: 'timeout (25s)' }); },
      });
    });
  }

  async function diagnostico() {
    const L = [];
    const ok = k => k ? '✅' : '❌';

    L.push(`V4 Lead Analyzer · v${VERSION}`);
    L.push('═'.repeat(46), '');

    L.push(`${ok(initOk)} Inicialização ${initOk ? 'completa' : 'INCOMPLETA'}`);
    if (!initOk) {
      erroInit.forEach(e => L.push(`   ✗ ${e}`));
      L.push('   → o script foi copiado pela metade. Reinstale colando o arquivo inteiro.');
    }
    L.push(`${ok(!modoRace())} Modo econômico: ${modoRace() ? 'NÃO (race ligado — paga 2 APIs)' : 'sim'}`);

    const naPagina = /brokers\.mktlab\.app/.test(location.hostname);
    L.push(`${ok(naPagina)} Página correta (${location.hostname})`);
    if (!naPagina) L.push('   → o script só roda em brokers.mktlab.app');

    // v19.1: teste funcional do grounding — é o que separa "chave ok" de
    // "a busca está funcionando".
    L.push('', '━━━ TESTE REAL DA BUSCA WEB ━━━');
    // v19.5: o teste leva até 25s e o painel ficava parado, sem sinal de vida
    mostrarDica('<b>🩺 Testando as APIs…</b><br>Consultando o Gemini com busca real. Até 25 segundos.', 26000);
    const t = await testarBuscaReal();
    if (t.erro) {
      L.push(`❌ falhou: ${t.erro}`);
    } else {
      L.push(`${t.queries > 0 ? '✅' : '❌'} buscas feitas: ${t.queries}${t.queries ? ` (${t.exemplos.join(' | ')})` : ''}`);
      L.push(`   fontes consultadas: ${t.chunks}`);
      L.push(`   tempo: ${(t.ms / 1000).toFixed(1)}s${t.finish && t.finish !== 'STOP' ? ` · finish: ${t.finish}` : ''}`);
      L.push(`   resposta: ${t.texto || '(vazia)'}`);
      if (t.queries === 0) {
        L.push('');
        L.push('   ⚠️ ZERO BUSCAS. O google_search está declarado mas não foi');
        L.push('      chamado. No Gemini 2.5 a decisão de usar ferramenta acontece');
        L.push('      no raciocínio — thinkingBudget 0 desliga isso.');
      } else if (!t.achou) {
        L.push('');
        L.push('   ⚠️ buscou mas não achou o CNPJ da empresa de teste.');
        L.push('      O grounding roda, mas não alcança bases cadastrais.');
      } else {
        L.push('   ✅ buscou E achou — a investigação está funcionando.');
      }
    }
    L.push('');

    // v19.1: o diagnóstico dizia "chave configurada ✅" mesmo com o chip em "?".
    // Ter chave não é o mesmo que a chave funcionar. Agora reporta o estado
    // real que a verificação de saúde apurou.
    const temOA = !!GM_getValue('v4_openai_key', '');
    const temGem = !!GM_getValue('v4_gemini_key', '');
    const estado = (h) => !h ? 'não verificada'
      : h.state === 'on' ? 'ok'
      : h.state === 'warn' ? `atenção${h.semBusca ? ' · sem busca web' : ''}`
      : `FALHOU${h.status ? ` (${h.status})` : ''}${h.erro ? ` — ${String(h.erro).slice(0, 50)}` : ''}`;

    const hOA = v4Health && v4Health.openai;
    const hGem = v4Health && v4Health.gemini;
    L.push(`${ok(temOA || temGem)} Chave de IA configurada`);
    if (temGem) L.push(`   Gemini: ${estado(hGem)}${hGem && hGem.modelo ? ` · ${hGem.modelo}` : ''}`);
    if (temOA) L.push(`   OpenAI: ${estado(hOA)}${hOA && hOA.modelo ? ` · ${hOA.modelo}` : ''}`);
    if (hOA && hOA.state !== 'on') {
      L.push('   → a OpenAI é o caminho alternativo; com o Gemini ok, a análise roda igual');
    };
    L.push(`   OpenAI: ${temOA ? 'sim' : 'NÃO'} · Gemini: ${temGem ? 'sim' : 'NÃO'}`);
    if (!temOA && !temGem) L.push('   → cole o código da Re: ⚙ Config → 🔑 Setup → opção 1');

    const auto = GM_getValue('v4_auto_selecao', '1') === '1';
    L.push(`${ok(auto)} Análise automática ao marcar texto: ${auto ? 'LIGADA' : 'DESLIGADA'}`);
    if (!auto) L.push('   → clique em ⚡ Auto no rodapé para ligar');


    if (v4Health) {
      const st = s => s === 'on' ? '✅' : s === 'unset' ? '⚪' : '❌';
      L.push('', 'INTEGRAÇÕES');
      L.push(`  ${st(v4Health.openai.state)} OpenAI    ${v4Health.openai.erro || ''}`);
      L.push(`  ${st(v4Health.gemini.state)} Gemini    ${v4Health.gemini.erro || ''}`);
      L.push(`  ${st(v4Health.brasil.state)} BrasilAPI`);
    } else {
      L.push('', '⚠️ Integrações ainda não testadas — clique no ↻ do painel');
    }

    // estado visual do painel — revela painel invisível
    const p = panelEl();
    L.push('', 'PAINEL');
    if (!p) {
      L.push('  ❌ elemento do painel não existe — script copiado pela metade');
    } else {
      const r = p.getBoundingClientRect();
      const aberto = overlay.classList.contains('active');
      const visivel = r.width >= 120 && r.height >= 80 && r.right > 40 && r.bottom > 40;
      L.push(`  ${aberto ? '✅' : '⚪'} ${aberto ? 'aberto' : 'fechado'} · layout: ${layout()}`);
      L.push(`  ${visivel ? '✅' : '❌'} tamanho ${Math.round(r.width)}×${Math.round(r.height)} em (${Math.round(r.left)}, ${Math.round(r.top)})`);
      if (!visivel && aberto) L.push('   → painel invisível. Aperte Ctrl+Shift+V para restaurar.');
      L.push(`  tela: ${window.innerWidth}×${window.innerHeight}`);
    }

    // testa a seleção atual, se houver
    const sel = (window.getSelection().toString() || '').trim();
    L.push('', 'SELEÇÃO ATUAL');
    if (!sel) {
      L.push('  (nada marcado)');
      L.push('  → marque o bloco do lead na página e clique aqui de novo');
    } else {
      const av = avaliarSelecao(sel);
      L.push(`  ${sel.length} caracteres`);
      L.push(`  ${ok(av.ok)} ${av.ok ? `seria analisada (${av.hits} campos reconhecidos)` : av.motivo}`);
      const achados = ROTULOS_LEAD.map((re, i) =>
        re.test(sel) ? ['faturamento','segmento','canal','tipo de produto','responsável','e-mail','telefone','urgência','documento','data','cidade'][i] : null
      ).filter(Boolean);
      L.push(`  campos achados: ${achados.join(', ') || 'nenhum'}`);
      L.push('', '  primeiros 120 caracteres do que você marcou:');
      L.push('  "' + sel.slice(0, 120).replace(/\s+/g, ' ') + '"');
    }

    L.push('', '═'.repeat(46));
    L.push('Atalho de emergência: Ctrl+Shift+V restaura o painel.');
    L.push('Se continuar sem funcionar, mande este texto para a Re.');

    const txt = L.join('\n');
    mostrarRelatorio(txt);
  }

  // v19.5: o relatório saía num confirm() de 40 linhas, ilegível e sem rolagem.
  // Agora abre num painel com fonte monoespaçada e botão de copiar.
  function mostrarRelatorio(txt) {
    document.querySelectorAll('.v4-relatorio').forEach(e => e.remove());
    const w = document.createElement('div');
    w.className = 'v4-relatorio';
    w.style.cssText = `position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.72);
      display:flex;align-items:center;justify-content:center;padding:24px`;
    w.innerHTML = `
      <div style="background:#0E0E0E;border:1px solid #2A2A2A;border-radius:12px;
           max-width:760px;width:100%;max-height:84vh;display:flex;flex-direction:column;
           box-shadow:0 20px 60px rgba(0,0,0,.7)">
        <div style="padding:14px 18px;border-bottom:1px solid #1F1F1F;display:flex;
             align-items:center;justify-content:space-between">
          <div style="font-size:12px;font-weight:800;letter-spacing:1px;color:#93C5FD">
            🩺 DIAGNÓSTICO
          </div>
          <button data-fechar style="background:none;border:1px solid #2A2A2A;color:#8A8A8A;
                  border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px">✕</button>
        </div>
        <pre style="margin:0;padding:16px 18px;overflow:auto;flex:1;white-space:pre-wrap;
             word-break:break-word;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;
             color:#D8D8D8">${esc(txt)}</pre>
        <div style="padding:12px 18px;border-top:1px solid #1F1F1F;display:flex;gap:8px;
             justify-content:flex-end">
          <button data-copiar style="background:#1A1A1A;border:1px solid #3B82F650;color:#93C5FD;
                  border-radius:6px;padding:7px 14px;cursor:pointer;font-size:12px;font-weight:700">
            📋 Copiar relatório
          </button>
        </div>
      </div>`;
    document.body.appendChild(w);
    w.addEventListener('click', e => { if (e.target === w) w.remove(); });
    w.querySelector('[data-fechar]').addEventListener('click', () => w.remove());
    w.querySelector('[data-copiar]').addEventListener('click', () => {
      const b = w.querySelector('[data-copiar]');
      navigator.clipboard.writeText(txt)
        .then(() => { b.textContent = '✓ copiado'; })
        .catch(() => { b.textContent = '✕ falhou — selecione o texto'; });
    });
  }
  conectar('v4-diag', 'click', diagnostico);

  conectar('v4-consumo', 'click', abrirConsumo);

  conectar('v4-race', 'click', () => {
    const on = modoRace();
    if (!on && !confirm(
      'Ligar o modo paralelo?\n\n'
      + 'Ganha ~2-3 segundos por lead, mas dispara Gemini E OpenAI ao mesmo tempo '
      + 'e paga as duas chamadas — cerca de 6x o custo por análise.\n\n'
      + 'Só vale quando o timer do leilão estiver apertado.'
    )) return;
    GM_setValue('v4_race', on ? '0' : '1');
    renderRaceBtn();
  renderAutoM2Btn();
  aplicarModoTime();   // v23.0: esconde o que o SDR não deve usar

  // v22.0: vigia a página de aquisições. A tabela é carregada por JS, então
  // observa mudanças no DOM em vez de ler uma vez só. O envio pro GHL acontece
  // sem clique — da compra ao CRM em segundos.
  (function ligarVigiaAquisicoes() {
    let ultimo = 0;
    const tentar = () => {
      const agora = Date.now();
      if (agora - ultimo < 2500) return;          // não martela o DOM
      ultimo = agora;
      try { vigiarAquisicoes(); } catch (e) { console.warn('[V4] vigia:', e); }
    };
    try {
      new MutationObserver(tentar).observe(document.body, { childList: true, subtree: true });
      setTimeout(tentar, 1500);
    } catch (e) {}
  })();

  conectar('v4-auto-m2', 'click', () => {
    const novo = autoM2Ligado() ? '0' : '1';
    GM_setValue('v4_auto_m2', novo);
    renderAutoM2Btn();
    mostrarDica(novo === '1'
      ? '<b>Auto-M2 ligado</b><br>O Momento 2 roda sozinho quando houver box amarelo ou vermelho.'
      : '<b>Auto-M2 desligado</b><br>O Momento 2 só roda quando você clicar.', 4000);
  });

  // v12.1: quem recebeu a instalação por código não é dono — esconde os botões
  // que só fazem sentido pra quem administra as chaves e o custo.
  // O time vê: Histórico · Auto · Diagnóstico · Mais opções → Chaves, Consumo · Cache
  (function ajustarRodapePorPerfil() {
    const dono = GM_getValue('v4_dono', '') === '1';
    if (dono) return;
    document.querySelectorAll('.v4-so-dono').forEach(el => { el.style.display = 'none'; });
    const s = document.getElementById('v4-setup');
    if (s) s.textContent = '🔑 Colar código';
  })();
  });
  renderRaceBtn();
  renderAutoM2Btn();
  conectar('v4-auto-m2', 'click', () => {
    const novo = autoM2Ligado() ? '0' : '1';
    GM_setValue('v4_auto_m2', novo);
    renderAutoM2Btn();
    mostrarDica(novo === '1'
      ? '<b>Auto-M2 ligado</b><br>O Momento 2 roda sozinho quando houver box amarelo ou vermelho.'
      : '<b>Auto-M2 desligado</b><br>O Momento 2 só roda quando você clicar.', 4000);
  });

  // v12.1: quem recebeu a instalação por código não é dono — esconde os botões
  // que só fazem sentido pra quem administra as chaves e o custo.
  // O time vê: Histórico · Auto · Diagnóstico · Mais opções → Chaves, Consumo · Cache
  (function ajustarRodapePorPerfil() {
    const dono = GM_getValue('v4_dono', '') === '1';
    if (dono) return;
    document.querySelectorAll('.v4-so-dono').forEach(el => { el.style.display = 'none'; });
    const s = document.getElementById('v4-setup');
    if (s) s.textContent = '🔑 Colar código';
  })();

  conectar('v4-model', 'click', () => {
    const atual = GM_getValue('v4_openai_search_model', '');
    const funcionando = GM_getValue('v4_openai_search_ok', '');
    const m = prompt(
      '🔧 Modelo de busca da OpenAI\n\n' +
      'Os modelos de busca mudam de nome e são descontinuados.\n' +
      'O script tenta uma cadeia automática — só preencha aqui se ela falhar.\n\n' +
      (funcionando ? `Funcionando agora: ${funcionando}\n\n` : 'Nenhum funcionou ainda.\n\n') +
      'Cadeia padrão:\n' + OPENAI_SEARCH_CHAIN.map(c => `  ${c.api}: ${c.model}`).join('\n') +
      '\n\nDeixe vazio para usar só a cadeia padrão:',
      atual
    );
    if (m === null) return;
    GM_setValue('v4_openai_search_model', m.trim());
    GM_setValue('v4_openai_search_ok', '');
    alert(m.trim() ? `Modelo "${m.trim()}" será tentado primeiro.` : 'Voltou para a cadeia padrão.');
  });

  conectar('v4-key', 'click', () => {
    if (confirm('Remover TODAS as chaves (OpenAI, Gemini, OutboundPro)?')) {
      GM_setValue('v4_openai_key', ''); GM_setValue('v4_gemini_key', '');
      GM_setValue('v4_outbound_token', ''); GM_setValue('v4_ob_asked', '');
      GM_setValue('v4_openai_search_ok', '');
      v4Health = null; alert('Chaves removidas.');
    }
  });
  conectar('v4-clear-cache', 'click', () => {
    if (confirm('Limpar cache/histórico de leads?\n\nDica: exporte CSV antes.')) { clearAllCache(); alert('Limpo.'); }
  });
  conectar('v4-hist-search', 'input', e => { hSearch = e.target.value; renderHist(); });
  document.querySelectorAll('.v4-hf').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.v4-hf').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    hFilter = b.getAttribute('data-f');
    renderHist();
  }));
  conectar('v4-export-csv', 'click', exportCSV);
  conectar('v4-export-json', 'click', exportJSON);
  conectar('v4-hist-clear', 'click', () => {
    const n = listHistory().length;
    if (!n) { alert('Histórico já vazio.'); return; }
    if (confirm(`Apagar ${n} leads do histórico?\n\nExporte antes se quiser guardar.`)) { clearAllCache(); renderHist(); }
  });

  overlay.addEventListener('click', e => {
    // no modo flutuante o clique fora é da página, não do painel
    if (!modoFlutuante() && e.target === overlay) closePanel();
  });
  histOverlay.addEventListener('click', e => { if (e.target === histOverlay) closeHist(); });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (histOverlay.classList.contains('active')) { closeHist(); return; }
    // se você entrou no detalhe a partir da faixa, ESC volta pra faixa
    if (overlay.classList.contains('veio-da-faixa')) { voltarParaFaixa(); return; }
    closePanel();
  });

  // v9.35: se algum botão não conectou, avisa em vez de ficar quebrado em silêncio
  if (!initOk) {
    console.error('[V4] problemas na inicialização:', erroInit);
    setTimeout(() => {
      const b = document.createElement('div');
      b.style.cssText = 'position:fixed;bottom:86px;right:24px;z-index:2147483647;max-width:320px;'
        + 'padding:12px 14px;border-radius:10px;background:#3B0D0D;border:1px solid #7F1D1D;'
        + 'color:#FECACA;font:12px/1.5 -apple-system,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.6)';
      b.innerHTML = '<b>⚠️ Instalação incompleta</b><br>'
        + 'Alguns botões não carregaram. Provável cópia parcial do script.<br>'
        + '<span style="opacity:.8">Reinstale colando o arquivo inteiro, ou clique em 🩺 Diagnóstico.</span>';
      document.body.appendChild(b);
      setTimeout(() => b.remove(), 15000);
    }, 2500);
  }

  setTimeout(() => refreshHealth(true, isStale()), 1500);  // funcional só se estiver velho

  } // init
})();
