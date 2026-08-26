#!/usr/bin/env python3
# Transcreve um áudio (pt-BR) com faster-whisper, local e offline.
# Uso: python transcribe.py <arquivo-de-audio>
# Saída: uma linha JSON {"text","duration","language"} no stdout.
#
# O CAMINHO ACOMPANHA A INSTÂNCIA — não é constante. Este arquivo veio do fork com
# "/opt/instancia-c/data/whisper-models" chumbado: o caminho da instância de OUTRA pessoa. Aqui
# isso não deu erro de permissão só; deu erro de permissão apontando pra pasta de outra
# dona, o que em outra máquina teria sido pior — teria FUNCIONADO, gravando o cache de uma
# instância dentro da outra. Mesma classe do nome do dono no código (ver src/core/dono.mjs).
import sys, json, os

MODEL_SIZE = "small"          # equilíbrio qualidade/velocidade pra CPU
SISTEMA = os.environ.get("TIM_SISTEMA", "vendas-multicanal")
MODEL_DIR = os.environ.get("TIM_WHISPER_MODELS", f"/opt/{SISTEMA}/data/whisper-models")

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "uso: transcribe.py <arquivo>"})); return
    path = sys.argv[1]
    try:
        from faster_whisper import WhisperModel
        model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8", download_root=MODEL_DIR)
        segments, info = model.transcribe(path, language="pt", vad_filter=True, beam_size=1)
        text = "".join(s.text for s in segments).strip()
        print(json.dumps({"text": text, "duration": round(getattr(info, "duration", 0) or 0, 1), "language": getattr(info, "language", "pt")}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}))

if __name__ == "__main__":
    main()
