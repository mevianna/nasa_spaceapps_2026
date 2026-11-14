# TerraTrend ML

MVP desenvolvido para o desafio **Be An Earth System Trend Detective!** do NASA Space Apps Challenge 2026.

O aplicativo consulta séries mensais reais da NASA POWER para quatro cidades brasileiras e três variáveis ambientais. Ele remove o ciclo sazonal, estima a tendência por regressão linear, calcula um intervalo de confiança de 95% e usa um Isolation Forest para destacar meses incomuns.

## Executar localmente

Sirva a pasta `dist` com qualquer servidor HTTP estático. Por exemplo:

```powershell
python -m http.server 8000 --directory dist
```

Depois, abra `http://localhost:8000`.

## Dados

- NASA POWER Monthly API: https://power.larc.nasa.gov/docs/services/api/temporal/monthly/
- Período usado: 2001–2025
- Temperatura e precipitação: produtos derivados de MERRA-2
- Radiação solar: produtos derivados de CERES

Os dados são consultados diretamente no navegador e não são alterados ou gerados por IA.

## Machine Learning e estatística

1. A média de cada mês do ano é removida para reduzir a sazonalidade.
2. Uma regressão linear estima a taxa anual de mudança.
3. Um intervalo de confiança aproximado de 95% indica se a inclinação é diferente de zero.
4. Um Isolation Forest não supervisionado usa o resíduo da tendência e a mudança mensal para calcular a pontuação de anomalia.
5. Os 5% de maior pontuação são destacados como observações incomuns.

O modelo é descritivo e educacional. Ele não prevê o clima e não substitui uma análise científica revisada por especialistas.

## Uso de IA

Codex/ChatGPT auxiliou na definição do escopo, implementação, documentação e revisão do protótipo. Os valores científicos vêm exclusivamente da NASA POWER. O modelo de ML roda localmente no navegador.
