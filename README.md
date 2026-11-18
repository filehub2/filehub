# FileHub

Gerenciador web de arquivos com contas privadas e uma única pasta compartilhada. Compatível com Node.js 18.20.8 e Debian ARM64.

## Cloudflare Tunnel dinâmico

O `tunnel-manager.js` inicia `server.js` na porta 3001 e o Cloudflare Quick Tunnel. Quando o `cloudflared` informa um endereço `https://....trycloudflare.com`, o gerenciador atualiza `public/config.json` de forma atômica. O servidor entrega esse JSON com `Cache-Control: no-store`, e o `index.html` consulta o arquivo ao abrir e a cada 30 segundos. O botão **Copiar link público** usa o endereço atual.

As chamadas de API usam caminhos relativos (`/api/...`), portanto o navegador sempre conversa com o mesmo domínio usado para abrir a página. Não configure o JavaScript para chamar outro domínio de túnel.

**Limitação importante:** se um Quick Tunnel mudar de endereço, o endereço antigo deixa de funcionar. O JSON guarda a nova URL, mas não consegue redirecionar visitantes que ainda tentam abrir o endereço antigo. Para um endereço estável, configure um Named Tunnel com domínio próprio.

## Instalação automatizada

Envie o conteúdo deste projeto para um novo repositório GitHub. Copie `INSTALAR_FILEHUB.sh` para o Debian e execute:

```bash
chmod +x INSTALAR_FILEHUB.sh
sudo bash INSTALAR_FILEHUB.sh
```

O script pergunta a URL HTTPS do repositório, instala `cloudflared` se necessário, instala dependências Node, cria as pastas de dados e configura o serviço systemd `filehub`. Ele não substitui o Node.js instalado.

## Pastas

- Arquivos compartilhados: `/mnt/pendrive/FileHub/Compartilhados`
- Dados privados das contas: `/root/.filehub-data`
- Código: `/root/filehub`

## Comandos

```bash
systemctl status filehub
journalctl -u filehub -f
systemctl restart filehub
systemctl stop filehub
systemctl start filehub
cd /root/filehub && git pull --ff-only && npm install --omit=dev && systemctl restart filehub
cat /root/filehub/public/config.json
```

O PartyBlox permanece independente na porta 3000. FileHub usa a porta 3001.

## Segurança

- Não exponha a porta 3001 diretamente à internet; use o túnel HTTPS.
- Faça backup de `/root/.filehub-data` e `/mnt/pendrive/FileHub/Compartilhados`.
- Node.js 18 está fora do suporte oficial; o projeto preserva o runtime informado, mas recomenda-se migrar para uma versão LTS suportada.
- Quick Tunnel é indicado para testes. Para endereço fixo, use Named Tunnel.
