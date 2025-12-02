// Jobs.cz scraper - CheerioCrawler implementation
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

// Single-entrypoint main
await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            keyword = '', location = '', category = '', results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 999, collectDetails = true, startUrl, startUrls, url, proxyConfiguration,
            dedupe = true,
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
            if (kw) {
                const keywords = String(kw).trim();
                u.searchParams.set('q[]', keywords);
                log.info(`Searching for keyword: "${keywords}"`);
            }
            if (loc) {
                const locality = String(loc).trim();
                u.searchParams.set('locality[]', locality);
                log.info(`Filtering by location: "${locality}"`);
            }
            if (cat) {
                const categoryVal = String(cat).trim();
                u.searchParams.set('category[]', categoryVal);
                log.info(`Filtering by category: "${categoryVal}"`);
            }
            const finalUrl = u.href;
            log.info(`Built search URL: ${finalUrl}`);
            return finalUrl;
        };

        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) {
            initial.push(...startUrls);
            log.info(`Using ${startUrls.length} custom start URL(s)`);
        }
        if (startUrl) {
            initial.push(startUrl);
            log.info(`Using custom start URL: ${startUrl}`);
        }
        if (url) {
            initial.push(url);
            log.info(`Using custom URL: ${url}`);
        }
        if (!initial.length) {
            const builtUrl = buildStartUrl(keyword, location, category);
            initial.push(builtUrl);
        }

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

        let saved = 0;
        const seenUrls = new Set();

        const enqueueDetail = async (crawler, links) => {
            const remaining = RESULTS_WANTED - saved;
            const uniqueLinks = dedupe ? links.filter(l => !seenUrls.has(l)) : links;
            uniqueLinks.forEach(l => seenUrls.add(l));
            const toTake = uniqueLinks.slice(0, Math.max(0, remaining));
            if (!toTake.length) return;
            await crawler.addRequests(toTake.map(u => ({ url: u, userData: { label: 'DETAIL' } })));
        };

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

        function findNextPage(baseUrl, currentPage) {
            // Jobs.cz uses page parameter for pagination
            const nextPage = currentPage + 1;
            try {
                const url = new URL(baseUrl);
                url.searchParams.set('page', String(nextPage));
                return url.href;
            } catch (err) {
                log.warning(`Failed to construct next page URL from ${baseUrl}: ${err.message}`);
                return null;
            }
        }

        function hasNextPage($) {
            // Check if there's a next page link or pagination indicator
            const nextBtn = $('a[rel="next"]').length > 0;
            const paginationLinks = $('a[href*="page="]').length > 0;
            const disabledNext = $('.pagination .disabled:contains("›")').length > 0 || 
                                $('.pagination .disabled:contains("Další")').length > 0;
            return (nextBtn || paginationLinks) && !disabledNext;
        }

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 3,
            useSessionPool: true,
            maxConcurrency: 10,
            requestHandlerTimeoutSecs: 90,
            async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                if (label === 'LIST') {
                    const links = findJobLinks($, request.url);
                    crawlerLog.info(`LIST page ${pageNo} -> ${links.length} job links at ${request.url}`);

                    if (collectDetails) {
                        await enqueueDetail(crawler, links);
                    } else {
                        const remaining = RESULTS_WANTED - saved;
                        const uniqueLinks = dedupe ? links.filter(l => !seenUrls.has(l)) : links;
                        uniqueLinks.forEach(l => seenUrls.add(l));
                        const toPush = uniqueLinks.slice(0, Math.max(0, remaining)).map(u => ({ url: u, _source: 'jobs.cz' }));
                        if (toPush.length) {
                            await Dataset.pushData(toPush);
                            saved += toPush.length;
                        }
                    }

                    // Check if we should continue pagination
                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES && links.length > 0) {
                        // Check if there's actually a next page available
                        const hasMore = hasNextPage($);
                        if (hasMore) {
                            const next = findNextPage(request.url, pageNo);
                            if (next) {
                                crawlerLog.info(`Queueing next page ${pageNo + 1}: ${next}`);
                                await crawler.addRequests([{ url: next, userData: { label: 'LIST', pageNo: pageNo + 1 } }]);
                            } else {
                                crawlerLog.warning(`Could not construct next page URL for page ${pageNo + 1}`);
                            }
                        } else {
                            crawlerLog.info(`No more pages available after page ${pageNo}`);
                        }
                    } else if (saved >= RESULTS_WANTED) {
                        crawlerLog.info(`Reached target of ${RESULTS_WANTED} results`);
                    } else if (pageNo >= MAX_PAGES) {
                        crawlerLog.info(`Reached maximum pages limit: ${MAX_PAGES}`);
                    } else if (links.length === 0) {
                        crawlerLog.info(`No job links found on page ${pageNo}`);
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
