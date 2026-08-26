// Catálogo de cidades pra extrair cidade de TEXTO sem chutar.
//
// Perfil do Tinder/Badoo já vem estruturado ("Cascavel, Paraná") — esses NÃO precisam
// estar aqui. O catálogo existe porque "sou de X" no WhatsApp casa qualquer X se a
// gente aceitar texto livre: "sou da área", "sou do setor", "moro no motel".
//
// Lista fechada, sem rede, sem modelo. Nome sem acento é a chave; o nome canônico
// (com acento, título) é o que vira etiqueta.

const ESTADOS = {
  acre: 'AC', alagoas: 'AL', amapa: 'AP', amazonas: 'AM', bahia: 'BA', ceara: 'CE',
  'distrito federal': 'DF', 'espirito santo': 'ES', goias: 'GO', maranhao: 'MA',
  'mato grosso': 'MT', 'mato grosso do sul': 'MS', 'minas gerais': 'MG', para: 'PA',
  paraiba: 'PB', parana: 'PR', pernambuco: 'PE', piaui: 'PI', 'rio de janeiro': 'RJ',
  'rio grande do norte': 'RN', 'rio grande do sul': 'RS', rondonia: 'RO', roraima: 'RR',
  'santa catarina': 'SC', 'sao paulo': 'SP', sergipe: 'SE', tocantins: 'TO',
}

const UF = {
  ac: 'AC', al: 'AL', ap: 'AP', am: 'AM', ba: 'BA', ce: 'CE', df: 'DF', es: 'ES',
  go: 'GO', ma: 'MA', mt: 'MT', ms: 'MS', mg: 'MG', pa: 'PA', pb: 'PB', pr: 'PR',
  pe: 'PE', pi: 'PI', rj: 'RJ', rn: 'RN', rs: 'RS', ro: 'RO', rr: 'RR', sc: 'SC',
  sp: 'SP', se: 'SE', to: 'TO',
}

// Cidade canônica + UF quando é inequívoca. "São Paulo" é a capital, não o estado —
// o estado só entra como ESTADOS, e "sou de SP" é rejeitado (ambíguo).
const LISTA = [
  ['São Paulo', 'SP'], ['Rio de Janeiro', 'RJ'], ['Belo Horizonte', 'MG'], ['Brasília', 'DF'],
  ['Salvador', 'BA'], ['Fortaleza', 'CE'], ['Recife', 'PE'], ['Porto Alegre', 'RS'],
  ['Curitiba', 'PR'], ['Manaus', 'AM'], ['Belém', 'PA'], ['Goiânia', 'GO'],
  ['Guarulhos', 'SP'], ['Campinas', 'SP'], ['São Gonçalo', 'RJ'], ['São Luís', 'MA'],
  ['Maceió', 'AL'], ['Duque de Caxias', 'RJ'], ['Natal', 'RN'], ['Teresina', 'PI'],
  ['Campo Grande', 'MS'], ['São Bernardo do Campo', 'SP'], ['pessoa operadora Pessoa', 'PB'],
  ['Santo André', 'SP'], ['Osasco', 'SP'], ['São José dos Campos', 'SP'], ['Ribeirão Preto', 'SP'],
  ['Uberlândia', 'MG'], ['Sorocaba', 'SP'], ['Contagem', 'MG'], ['Aracaju', 'SE'],
  ['Feira de Santana', 'BA'], ['Cuiabá', 'MT'], ['Joinville', 'SC'], ['Juiz de Fora', 'MG'],
  ['Londrina', 'PR'], ['Aparecida de Goiânia', 'GO'], ['Niterói', 'RJ'], ['Ananindeua', 'PA'],
  ['Porto Velho', 'RO'], ['Serra', 'ES'], ['Caxias do Sul', 'RS'], ['Campos dos Goytacazes', 'RJ'],
  ['Macapá', 'AP'], ['Florianópolis', 'SC'], ['Vila Velha', 'ES'], ['Mauá', 'SP'],
  ['São pessoa operadora de Meriti', 'RJ'], ['São José do Rio Preto', 'SP'], ['Mogi das Cruzes', 'SP'],
  ['Betim', 'MG'], ['Santos', 'SP'], ['Diadema', 'SP'], ['Maringá', 'PR'],
  ['Jundiaí', 'SP'], ['Carapicuíba', 'SP'], ['Montes Claros', 'MG'], ['Manoel Ribas', 'PR'],
  ['Piracicaba', 'SP'], ['Olinda', 'PE'], ['Cariacica', 'ES'], ['Bauru', 'SP'],
  ['Itaquaquecetuba', 'SP'], ['São Vicente', 'SP'], ['Franca', 'SP'], ['Blumenau', 'SC'],
  ['Ponta Grossa', 'PR'], ['Canoas', 'RS'], ['Pelotas', 'RS'], ['Vitória', 'ES'],
  ['Caucaia', 'CE'], ['Petrópolis', 'RJ'], ['Uberaba', 'MG'], ['Paulista', 'PE'],
  ['Cascavel', 'PR'], ['Foz do Iguaçu', 'PR'], ['Toledo', 'PR'], ['Guarapuava', 'PR'],
  ['Umuarama', 'PR'], ['Paranavaí', 'PR'], ['Apucarana', 'PR'], ['Araucária', 'PR'],
  ['Colombo', 'PR'], ['Pinhais', 'PR'], ['São José dos Pinhais', 'PR'],
  ['Francisco Beltrão', 'PR'], ['Pato Branco', 'PR'], ['Cianorte', 'PR'],
  ['Campo Mourão', 'PR'], ['Paranaguá', 'PR'], ['Almirante Tamandaré', 'PR'],
  ['Palotina', 'PR'], ['Tupãssi', 'PR'], ['Marechal Cândido Rondon', 'PR'],
  ['Quatro Pontes', 'PR'], ['Matelândia', 'PR'], ['Medianeira', 'PR'],
  ['Ouro Verde do Oeste', 'PR'], ['Assis Chateaubriand', 'PR'], ['Assis Chateubriand', 'PR'],
  ['São Pedro do Iguaçu', 'PR'], ['Santa Helena', 'PR'], ['Guaíra', 'PR'],
  ['Terra Roxa', 'PR'], ['Nova Santa Rosa', 'PR'], ['Mercedes', 'PR'],
  ['Entre Rios do Oeste', 'PR'], ['Pato Bragado', 'PR'], ['Itaipulândia', 'PR'],
  ['Missal', 'PR'], ['Ramilândia', 'PR'], ['Diamante d\'Oeste', 'PR'],
  ['Céu Azul', 'PR'], ['Santa Terezinha de Itaipu', 'PR'], ['São Miguel do Iguaçu', 'PR'],
  ['Serranópolis do Iguaçu', 'PR'], ['Capitão Leônidas Marques', 'PR'],
  ['Laranjeiras do Sul', 'PR'], ['Dois Vizinhos', 'PR'], ['Francisco Alves', 'PR'],
  ['Iporã', 'PR'], ['Alto Piquiri', 'PR'], ['Perobal', 'PR'], ['Cafezal do Sul', 'PR'],
  ['Brasilândia do Sul', 'PR'], ['Nova Olímpia', 'PR'], ['Maria Helena', 'PR'],
  ['Douradina', 'PR'], ['Icaraíma', 'PR'], ['Alto Paraíso', 'PR'], ['Xambrê', 'PR'],
  ['Maripá', 'PR'], ['Nova Aurora', 'PR'], ['Corbélia', 'PR'], ['Braganey', 'PR'],
  ['Cafelândia', 'PR'], ['Jesuítas', 'PR'], ['Formosa do Oeste', 'PR'],
  ['Iracema do Oeste', 'PR'], ['Anahy', 'PR'], ['Boa Vista da Aparecida', 'PR'],
  ['Três Barras do Paraná', 'PR'], ['Catanduvas', 'PR'], ['Ibema', 'PR'],
  ['Guaraniaçu', 'PR'], ['Lindoeste', 'PR'], ['Santa Lúcia', 'PR'],
  ['Vera Cruz do Oeste', 'PR'], ['Céu Azul', 'PR'], ['Capitão Leônidas Marques', 'PR'],
  ['Quedas do Iguaçu', 'PR'], ['Espigão Alto do Iguaçu', 'PR'],
  ['Nova Laranjeiras', 'PR'], ['Rio Bonito do Iguaçu', 'PR'],
  ['Chapecó', 'SC'], ['Criciúma', 'SC'], ['Itajaí', 'SC'], ['Lages', 'SC'],
  ['Balneário Camboriú', 'SC'], ['São José', 'SC'], ['Palhoça', 'SC'],
  ['Brusque', 'SC'], ['Tubarão', 'SC'], ['Caçador', 'SC'], ['Concórdia', 'SC'],
  ['Descanso', 'SC'], ['São Miguel do Oeste', 'SC'], ['Pinhalzinho', 'SC'],
  ['Xanxerê', 'SC'], ['Maravilha', 'SC'], ['Itapiranga', 'SC'],
  ['Dourados', 'MS'], ['Três Lagoas', 'MS'], ['Corumbá', 'MS'], ['Ponta Porã', 'MS'],
  ['Naviraí', 'MS'], ['Itaquiraí', 'MS'], ['Mundo Novo', 'MS'], ['Guaíra', 'PR'],
  ['Indaiatuba', 'SP'], ['Votorantim', 'SP'], ['Francisco Morato', 'SP'],
  ['Atibaia', 'SP'], ['Praia Grande', 'SP'], ['São José dos Campos', 'SP'],
  ['São Caetano do Sul', 'SP'], ['Taboão da Serra', 'SP'], ['Barueri', 'SP'],
  ['Embu das Artes', 'SP'], ['Cotia', 'SP'], ['Itu', 'SP'], ['Bragança Paulista', 'SP'],
  ['Jacareí', 'SP'], ['Taubaté', 'SP'], ['Limeira', 'SP'], ['Americana', 'SP'],
  ['Santa Bárbara d\'Oeste', 'SP'], ['Sumaré', 'SP'], ['Hortolândia', 'SP'],
  ['Rio Claro', 'SP'], ['Araraquara', 'SP'], ['São Carlos', 'SP'], ['Marília', 'SP'],
  ['Presidente Prudente', 'SP'], ['Araçatuba', 'SP'], ['Bauru', 'SP'],
  ['Ourinhos', 'SP'], ['Assis', 'SP'], ['Tupã', 'SP'], ['Quatá', 'SP'],
  ['Armação dos Búzios', 'RJ'], ['Cabo Frio', 'RJ'], ['Angra dos Reis', 'RJ'],
  ['Volta Redonda', 'RJ'], ['Nova Iguaçu', 'RJ'], ['Belford Roxo', 'RJ'],
  ['Caxias do Sul', 'RS'], ['Canoas', 'RS'], ['Pelotas', 'RS'], ['Santa Maria', 'RS'],
  ['Novo Hamburgo', 'RS'], ['São Leopoldo', 'RS'], ['Passo Fundo', 'RS'],
  ['Puerto Iguazú', null], ['Ciudad del Este', null],
]

export function semAcento(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

export function chaveCidade(s) {
  return semAcento(s).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function cap(w) {
  if (!w) return w
  return w.charAt(0).toUpperCase() + w.slice(1)
}

export function tituloCidade(s) {
  const minus = new Set(['de', 'da', 'do', 'das', 'dos', 'e'])
  return String(s || '').trim().split(/\s+/).map((w, i) => {
    const l = w.toLowerCase()
    if (i > 0 && minus.has(l)) return l
    if (l.startsWith("d'")) return "d'" + cap(l.slice(2))
    return cap(l)
  }).join(' ')
}

const POR_CHAVE = new Map()
for (const [nome, uf] of LISTA) {
  const k = chaveCidade(nome)
  if (!k) continue
  if (!POR_CHAVE.has(k)) POR_CHAVE.set(k, { nome, uf })
}

const CHAVES_ORDENADAS = [...POR_CHAVE.keys()].sort((a, b) => b.length - a.length)

export function ehEstado(s) {
  const k = chaveCidade(s)
  return !!ESTADOS[k] || !!UF[k]
}

export function ufDe(s) {
  const k = chaveCidade(s)
  return ESTADOS[k] || UF[k] || null
}

export function cidadeDoCatalogo(s) {
  const k = chaveCidade(s)
  if (!k || k.length < 3) return null
  return POR_CHAVE.get(k) || null
}

// Recorta "Cascavel, Paraná" / "São Paulo, São Paulo" / "Toledo".
// Estado sozinho ("Paraná") não é cidade. UF sozinha ("PR", "SP") também não.
export function parseCidadePerfil(bruto) {
  const s = String(bruto || '').replace(/\s+/g, ' ').trim()
  if (!s) return null
  const partes = s.split(',').map((p) => p.trim()).filter(Boolean)
  if (!partes.length) return null
  const nomeBruto = partes[0]
  if (nomeBruto.length < 3) return null
  const doCat = cidadeDoCatalogo(nomeBruto)
  // "São Paulo" é cidade E estado: o catálogo manda. "Paraná" não está no catálogo de
  // cidades, então sozinho não passa. UF ("PR") também não.
  if (!doCat && ehEstado(nomeBruto) && partes.length === 1) return null
  const ufTail = partes.length > 1 ? ufDe(partes[partes.length - 1]) : null
  const nome = doCat?.nome || tituloCidade(nomeBruto)
  const uf = doCat?.uf || ufTail || null
  if (!doCat && ehEstado(nome)) return null
  return { nome, uf, bruto: s }
}

// Acha uma cidade do catálogo no pedaço de texto DEPOIS de "moro em" / "sou de".
// Prefere o nome mais longo ("Foz do Iguaçu" ganha de um "Foz" que não existe).
export function cidadeNoTrecho(trecho) {
  const k = chaveCidade(trecho)
  if (!k) return null
  for (const chave of CHAVES_ORDENADAS) {
    if (k === chave || k.startsWith(chave + ' ') || k.includes(' ' + chave + ' ') || k.endsWith(' ' + chave)) {
      const borda = new RegExp(`(?:^| )${chave.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: |$)`)
      if (borda.test(k)) return POR_CHAVE.get(chave)
    }
  }
  return null
}

export const CATALOGO_TAMANHO = POR_CHAVE.size
