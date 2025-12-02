// Jobs.cz scraper - CheerioCrawler implementation with JSON API support
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { gotScraping } from 'got-scraping';

// Single-entrypoint main
await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            keyword = '', location = '', category = '', results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 999, collectDetails = true, startUrl, startUrls, url, proxyConfiguration,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 999;

        const toAbs = (href, base = 'https://www.jobs.cz') => {
            try { return new URL(href, base).href; } catch { return null; }
        };

        const cleanText = (html) => {
            if (!html) return '';
            const $ = cheerioLoad(html);
            $('script, style, noscript, iframe').remove();
            return $.root().text().replace(/\s+/g, ' ').trim();
        };

        const buildStartUrl = (kw, loc, cat) => {
            const u = new URL('https://www.jobs.cz/prace/');
            if (kw) u.searchParams.set('q[]', String(kw).trim());
            if (loc) u.searchParams.set('locality[]', String(loc).trim());
            if (cat) u.searchParams.set('category[]', String(cat).trim());
            return u.href;
        };

        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) initial.push(...startUrls);
        if (startUrl) initial.push(startUrl);
        if (url) initial.push(url);
        if (!initial.length) initial.push(buildStartUrl(keyword, location, category));

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

        let saved = 0;
        const seenUrls = new Set();

        function extractFromJsonLd($) {
            const scripts = $('script[type="application/ld+json"]');
            for (let i = 0; i < scripts.length; i++) {
                try {
                    const parsed = JSON.parse($(scripts[i]).html() || '');
                    const arr = Array.isArray(parsed) ? parsed : [parsed];
                    for (const e of arr) {
                        if (!e) continue;
                        const t = e['@type'] || e.type;
                        if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
                            return {
                                title: e.title || e.name || null,
                                company: e.hiringOrganization?.name || null,
                                date_posted: e.datePosted || null,
                                description_html: e.description || null,
                                location: (e.jobLocation && e.jobLocation.address && (e.jobLocation.address.addressLocality || e.jobLocation.address.addressRegion)) || null,
                                salary: e.baseSalary ? (e.baseSalary.value || (e.baseSalary.minValue && e.baseSalary.maxValue ? `${e.baseSalary.minValue} - ${e.baseSalary.maxValue}` : null)) : null,
                                job_type: e.employmentType || null,
                            };
                        }
                    }
                } catch (e) { /* ignore parsing errors */ }
            }
            return null;
        }

        function findJobLinks($, base) {
            const links = new Set();
            $('a[href]').each((_, a) => {
                const href = $(a).attr('href');
                if (!href) return;
                // Jobs.cz job detail pages have /rpd/ pattern
                if (/\/rpd\/\d+/i.test(href)) {
                    const abs = toAbs(href, base);
                    if (abs) {
                        // Clean search parameters but keep job ID
                        const cleanUrl = abs.split('?')[0];
                        links.add(cleanUrl);
                    }
                }
            });
            return [...links];
        }

        function findNextPage($, base, currentPage) {
            // Jobs.cz uses page parameter for pagination
            const nextPage = currentPage + 1;
            const url = new URL(base);
            url.searchParams.set('page', String(nextPage));
            return url.href;
        }

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 3,
            useSessionPool: true,
            maxConcurrency: 10,
            requestHandlerTimeoutSecs: 60,
            async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                if (label === 'LIST') {
                    const links = findJobLinks($, request.url);
                    crawlerLog.info(`LIST page ${pageNo} at ${request.url} -> found ${links.length} job links`);

                    if (collectDetails) {
                        const remaining = RESULTS_WANTED - saved;
                        const newLinks = links.filter(l => !seenUrls.has(l));
                        newLinks.forEach(l => seenUrls.add(l));
                        const toEnqueue = newLinks.slice(0, Math.max(0, remaining));
                        if (toEnqueue.length) await enqueueLinks({ urls: toEnqueue, userData: { label: 'DETAIL' } });
                    } else {
                        const remaining = RESULTS_WANTED - saved;
                        const newLinks = links.filter(l => !seenUrls.has(l));
                        newLinks.forEach(l => seenUrls.add(l));
                        const toPush = newLinks.slice(0, Math.max(0, remaining));
                        if (toPush.length) { 
                            await Dataset.pushData(toPush.map(u => ({ url: u, _source: 'jobs.cz' }))); 
                            saved += toPush.length; 
                        }
                    }

                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES && links.length > 0) {
                        const next = findNextPage($, request.url, pageNo);
                        if (next) await enqueueLinks({ urls: [next], userData: { label: 'LIST', pageNo: pageNo + 1 } });
                    }
                    return;
                }

                if (label === 'DETAIL') {
                    if (saved >= RESULTS_WANTED) return;
                    try {
                        const json = extractFromJsonLd($);
                        const data = json || {};
                        
                        // Title extraction
                        if (!data.title) {
                            data.title = $('h1').first().text().trim() || 
                                        $('[itemprop="title"]').first().text().trim() || 
                                        $('header h1').first().text().trim() || null;
                        }
                        
                        // Company name extraction - multiple fallback strategies
                        if (!data.company) {
                            data.company = $('[itemprop="hiringOrganization"] [itemprop="name"]').first().text().trim() ||
                                          $('[itemprop="hiringOrganization"]').first().text().trim() ||
                                          $('.company-name').first().text().trim() ||
                                          $('a[href*="/spolecnosti/"]').first().text().trim() ||
                                          $('[class*="company"]').filter((i, el) => {
                                              const txt = $(el).text().trim();
                                              return txt.length > 0 && txt.length < 100 && !txt.includes('\n');
                                          }).first().text().trim() || null;
                        }
                        
                        // Location extraction
                        if (!data.location) {
                            data.location = $('[itemprop="jobLocation"] [itemprop="address"]').first().text().trim() ||
                                           $('[itemprop="jobLocation"]').first().text().trim() ||
                                           $('[class*="location"]').first().text().trim() ||
                                           $('a[href*="mapy.cz"]').first().text().trim() || null;
                        }
                        
                        // Salary extraction
                        if (!data.salary) {
                            data.salary = $('[itemprop="baseSalary"]').first().text().trim() ||
                                         $('.salary').first().text().trim() ||
                                         $('[class*="salary"]').first().text().trim() ||
                                         $('*').filter((i, el) => {
                                             const txt = $(el).text();
                                             return /\d+\s*(?:000)?\s*(?:-|–|až)\s*\d+\s*(?:000)?\s*Kč/i.test(txt);
                                         }).first().text().trim() || null;
                        }
                        
                        // Job type / Employment form extraction
                        if (!data.job_type) {
                            data.job_type = $('[itemprop="employmentType"]').first().text().trim() ||
                                           $('*:contains("Employment form")').next().text().trim() ||
                                           $('*:contains("Position type")').parent().text().replace(/Position type:?\s*/i, '').trim() ||
                                           $('dt:contains("Employment form")').next('dd').text().trim() ||
                                           $('*').filter((i, el) => {
                                               const txt = $(el).text().toLowerCase();
                                               return (txt.includes('full-time') || txt.includes('full time') || 
                                                      txt.includes('part-time') || txt.includes('contract')) && 
                                                      txt.length < 50;
                                           }).first().text().trim() || null;
                        }
                        
                        // Description extraction - comprehensive approach
                        if (!data.description_html) {
                            const descSelectors = [
                                '[itemprop="description"]',
                                '.job-description',
                                '[class*="description"]',
                                '[class*="job-detail"]',
                                'article',
                                '.content',
                                'main'
                            ];
                            
                            for (const sel of descSelectors) {
                                const elem = $(sel).first();
                                if (elem.length && elem.text().trim().length > 100) {
                                    data.description_html = String(elem.html()).trim();
                                    break;
                                }
                            }
                            
                            // If still no description, try to get main content area
                            if (!data.description_html) {
                                const mainContent = $('body').find('*').filter((i, el) => {
                                    const txt = $(el).text().trim();
                                    return txt.length > 200 && $(el).children().length > 2;
                                }).first();
                                if (mainContent.length) {
                                    data.description_html = String(mainContent.html()).trim();
                                }
                            }
                        }
                        
                        // Description text from HTML
                        data.description_text = data.description_html ? cleanText(data.description_html) : null;
                        
                        // Date posted extraction
                        if (!data.date_posted) {
                            data.date_posted = $('[itemprop="datePosted"]').attr('content') ||
                                              $('[itemprop="datePosted"]').first().text().trim() ||
                                              $('time[datetime]').attr('datetime') ||
                                              $('time').first().text().trim() ||
                                              $('[class*="date"]').first().text().trim() || null;
                        }
                        
                        // Category extraction from page if not provided
                        let jobCategory = category;
                        if (!jobCategory) {
                            jobCategory = $('[itemprop="industry"]').first().text().trim() ||
                                        $('[class*="category"]').first().text().trim() ||
                                        $('*:contains("Listed in")').parent().text().replace(/Listed in:?\s*/i, '').trim() || null;
                        }

                        const item = {
                            title: data.title || null,
                            company: data.company || null,
                            category: jobCategory || null,
                            location: data.location || null,
                            salary: data.salary || null,
                            job_type: data.job_type || null,
                            date_posted: data.date_posted || null,
                            description_html: data.description_html || null,
                            description_text: data.description_text || null,
                            url: request.url,
                        };

                        await Dataset.pushData(item);
                        saved++;
                        crawlerLog.info(`Scraped job ${saved}/${RESULTS_WANTED}: ${item.title} at ${item.company || 'Unknown'}`);
                    } catch (err) { 
                        crawlerLog.error(`DETAIL ${request.url} failed: ${err.message}`);
                        crawlerLog.error(err.stack);
                    }
                }
            }
        });

        await crawler.run(initial.map(u => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })));
        log.info(`Finished. Saved ${saved} items`);
    } finally {
        await Actor.exit();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
