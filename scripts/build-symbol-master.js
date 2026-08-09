#!/usr/bin/env node
// KIS 종목 마스터를 내려받아 D1에 넣을 SQL(workers/symbols.sql)을 만든다.
//
// 마스터 파일은 ZIP + CP949 고정폭/탭 구분 포맷이라 Worker 안에서 다루기에는 무겁고,
// 신규상장·폐지 때나 바뀌므로 오프라인에서 만들어 두고 D1에 적재한다.
//
//   npm run symbols:build          SQL만 생성
//   npm run symbols:sync           원격 D1에 적재
//   npm run symbols:sync:local     로컬 D1에 적재

import { writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MASTER_BASE_URL = 'https://new.real.download.dws.co.kr/common/master';

// trailer: 각 행 끝의 부가정보 길이. 시장마다 다르고, 그 앞이 코드/종목명이다.
const DOMESTIC_MARKETS = [
    { file: 'kospi_code.mst.zip', entry: 'kospi_code.mst', exchange: 'KOSPI', suffix: '.KS', trailer: 227 },
    { file: 'kosdaq_code.mst.zip', entry: 'kosdaq_code.mst', exchange: 'KOSDAQ', suffix: '.KQ', trailer: 221 }
];

// 미국 3대 거래소. 필요하면 tse(도쿄), hks(홍콩) 등을 추가하면 된다.
const OVERSEAS_MARKETS = [
    { code: 'nas', exchange: 'NAS' },
    { code: 'nys', exchange: 'NYS' },
    { code: 'ams', exchange: 'AMS' }
];

// 국내 마스터 부가정보 영역 안에서 시가총액 규모 코드의 위치 (0:해당없음 1:대 2:중 3:소).
const DOMESTIC_SIZE_OFFSET = 2;

// 검색 정렬 우선순위. 숫자가 작을수록 위에 온다.
const DEFAULT_PRIORITY = 4;
const OVERSEAS_PRIORITY = 2;

// 해외 마스터 컬럼 위치 (탭 구분).
const OVERSEAS_COLUMNS = { exchange: 2, symbol: 4, nameKo: 6, nameEn: 7, type: 8 };

// 해외 종목 유형: 2=주식, 3=ETP(ETF). 지수/워런트는 제외한다.
const OVERSEAS_TYPES = new Set(['2', '3']);

const ROWS_PER_INSERT = 500;

async function main() {
    const symbols = new Map();

    for (const market of DOMESTIC_MARKETS) {
        const text = await downloadMaster(market.file, market.entry);
        const rows = parseDomestic(text, market);
        rows.forEach(row => symbols.set(row.ticker, row));
        console.log(`${market.exchange}: ${rows.length}종목`);
    }

    for (const market of OVERSEAS_MARKETS) {
        const text = await downloadMaster(`${market.code}mst.cod.zip`, `${market.code}mst.cod`);
        const rows = parseOverseas(text, market);
        // 같은 심볼이 여러 거래소에 있으면 먼저 읽은 쪽(NAS > NYS > AMS)을 유지한다.
        rows.forEach(row => {
            if (!symbols.has(row.ticker)) symbols.set(row.ticker, row);
        });
        console.log(`${market.exchange}: ${rows.length}종목`);
    }

    const outputPath = path.join(projectRoot(), 'workers', 'symbols.sql');
    writeFileSync(outputPath, buildSql([...symbols.values()]), 'utf8');
    console.log(`\n총 ${symbols.size}종목 → ${path.relative(projectRoot(), outputPath)}`);
}

async function downloadMaster(zipName, entryName) {
    const response = await fetch(`${MASTER_BASE_URL}/${zipName}`);
    if (!response.ok) {
        throw new Error(`${zipName} 다운로드 실패: HTTP ${response.status}`);
    }

    const zip = Buffer.from(await response.arrayBuffer());
    // 마스터 파일은 EUC-KR(CP949)로 인코딩되어 있다. 'cp949'는 표준 라벨이 아니라
    // TextDecoder가 받지 않으므로 동등한 'euc-kr'을 쓴다.
    return new TextDecoder('euc-kr').decode(readZipEntry(zip, entryName));
}

// 의존성 없이 단일 파일 ZIP을 푼다. 크기 정보가 항상 정확한 중앙 디렉터리를 기준으로 읽는다.
function readZipEntry(zip, entryName) {
    const eocdOffset = findEndOfCentralDirectory(zip);
    let entryOffset = zip.readUInt32LE(eocdOffset + 16);
    const entryCount = zip.readUInt16LE(eocdOffset + 10);

    for (let index = 0; index < entryCount; index += 1) {
        if (zip.readUInt32LE(entryOffset) !== 0x02014b50) {
            throw new Error('ZIP 중앙 디렉터리가 손상되었습니다.');
        }

        const method = zip.readUInt16LE(entryOffset + 10);
        const compressedSize = zip.readUInt32LE(entryOffset + 20);
        const nameLength = zip.readUInt16LE(entryOffset + 28);
        const extraLength = zip.readUInt16LE(entryOffset + 30);
        const commentLength = zip.readUInt16LE(entryOffset + 32);
        const localOffset = zip.readUInt32LE(entryOffset + 42);
        const name = zip.subarray(entryOffset + 46, entryOffset + 46 + nameLength).toString('latin1');

        // 국내 마스터는 소문자(kospi_code.mst), 해외는 대문자(NASMST.COD)로 들어있다.
        if (name.toUpperCase() === entryName.toUpperCase()) {
            return readLocalEntry(zip, localOffset, method, compressedSize);
        }

        entryOffset += 46 + nameLength + extraLength + commentLength;
    }

    throw new Error(`ZIP 안에서 ${entryName}을(를) 찾지 못했습니다.`);
}

function readLocalEntry(zip, localOffset, method, compressedSize) {
    if (zip.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error('ZIP 로컬 헤더가 손상되었습니다.');
    }

    const nameLength = zip.readUInt16LE(localOffset + 26);
    const extraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + nameLength + extraLength;
    const data = zip.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) return data;
    if (method === 8) return inflateRawSync(data);
    throw new Error(`지원하지 않는 ZIP 압축 방식입니다: ${method}`);
}

function findEndOfCentralDirectory(zip) {
    for (let offset = zip.length - 22; offset >= 0; offset -= 1) {
        if (zip.readUInt32LE(offset) === 0x06054b50) return offset;
    }
    throw new Error('ZIP 종료 레코드를 찾지 못했습니다.');
}

function parseDomestic(text, { exchange, suffix, trailer }) {
    return text.split('\n')
        .filter(line => line.length > trailer)
        .map(line => {
            const head = line.slice(0, line.length - trailer);
            const extra = line.slice(line.length - trailer);
            return {
                code: head.slice(0, 9).trim(),
                name: head.slice(21).trim(),
                size: extra.slice(DOMESTIC_SIZE_OFFSET, DOMESTIC_SIZE_OFFSET + 1)
            };
        })
        // 펀드/워런트 등은 코드 형태가 달라 걸러진다. 우선주(00088K)는 마지막 자리가 문자다.
        .filter(row => /^\d{5}[0-9A-Z]$/.test(row.code) && row.name)
        .map(row => ({
            ticker: `${row.code}${suffix}`,
            code: row.code,
            name: row.name,
            nameEn: '',
            market: 'domestic',
            exchange,
            priority: /^[123]$/.test(row.size) ? Number(row.size) : DEFAULT_PRIORITY
        }));
}

function parseOverseas(text, { exchange }) {
    return text.split('\n')
        .map(line => line.split('\t'))
        .filter(columns => columns.length > OVERSEAS_COLUMNS.type)
        .filter(columns => OVERSEAS_TYPES.has(columns[OVERSEAS_COLUMNS.type].trim()))
        .filter(columns => columns[OVERSEAS_COLUMNS.exchange].trim() === exchange)
        .map(columns => ({
            ticker: columns[OVERSEAS_COLUMNS.symbol].trim().toUpperCase(),
            code: columns[OVERSEAS_COLUMNS.symbol].trim().toUpperCase(),
            name: columns[OVERSEAS_COLUMNS.nameKo].trim(),
            nameEn: columns[OVERSEAS_COLUMNS.nameEn].trim(),
            market: 'overseas',
            exchange,
            priority: OVERSEAS_PRIORITY
        }))
        .filter(row => row.ticker && (row.name || row.nameEn));
}

function buildSql(rows) {
    const lines = ['-- scripts/build-symbol-master.js가 생성한 파일입니다. 직접 수정하지 마세요.', 'DELETE FROM symbols;'];

    for (let start = 0; start < rows.length; start += ROWS_PER_INSERT) {
        const chunk = rows.slice(start, start + ROWS_PER_INSERT);
        const values = chunk.map(row => {
            const text = [row.ticker, row.code, row.name, row.nameEn, row.market, row.exchange].map(quote).join(',');
            return `(${text},${row.priority})`;
        });
        lines.push(`INSERT INTO symbols (ticker, code, name, name_en, market, exchange, priority) VALUES\n${values.join(',\n')};`);
    }

    return `${lines.join('\n')}\n`;
}

function quote(value) {
    return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function projectRoot() {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

main().catch(error => {
    console.error(error.message);
    process.exit(1);
});
