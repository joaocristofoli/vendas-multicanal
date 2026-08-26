# Modelo de identidade privada

Esta pasta contém apenas modelos vazios. Não coloque dados reais aqui, porque os arquivos são versionados.

Na instalação, copie estes modelos para `data/sobre-mim/` e edite somente a cópia ignorada pelo Git:

```bash
mkdir -p data/sobre-mim
cp -R sobre-mim-fontes/. data/sobre-mim/
```

Preencha apenas informações confirmadas pela própria pessoa operadora. Não invente biografia nem extraia fatos de conversas privadas sem revisão e consentimento.

- `dono.json`: nome pelo qual a pessoa quer ser chamada e gênero declarado.
- `quem-eu-sou.md`: fatos que a IA pode usar.
- `como-eu-converso.md`: estilo medido em mensagens autorizadas.
- `nucleo-voz.md`: resumo curto do estilo.
- `criancas.json`: nomes que precisam ativar o filtro de proteção infantil.
- `exemplos-voz.json`: pares de texto ruim/bom autorizados.
- `pontes.json`: fatos por assunto que podem virar conexão na conversa.

Nome, telefone, endereço, documentos, fotos, vozes, conversas e credenciais nunca devem entrar no repositório.
