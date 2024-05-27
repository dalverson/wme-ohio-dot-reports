// ==UserScript==
// @name         WME Ohio DOT Reports
// @namespace    https://greasyfork.org/users/166713
// @version      2024.05.27.01
// @description  Display OH transportation department reports in WME.
// @author       DaveAcincy - based on VA DOT Reports by MapOMatic
// @homepage     https://www.waze.com/forum/viewtopic.php?t=297874
// @match        https://beta.waze.com/*editor*
// @match        https://www.waze.com/*editor*
// @exclude      https://www.waze.com/*user/*editor/*
// @grant        GM_xmlhttpRequest
// @connect      www.buckeyetraffic.org
// @connect      ohgo.com

// ==/UserScript==

/* global $ */
/* global OpenLayers */
/* global W */
/* global Waze */
/* global Components */
/* global I18n */

const DEC = s => atob(atob(s));
const TOKEN = 'WVhCcExXdGxlVDAzWXpNeE5XRmpPUzAwWlRKakxUUmxZVFl0T1dNM05pMWhOelpsT1dFMlkyVmhObU09';

(function() {
    'use strict';

    var _window = unsafeWindow ? unsafeWindow : window;

    var _settingsStoreName = 'oh_dot_report_settings';
    var _alertUpdate = false;
    var _debugLevel = 0;
    var _scriptVersion = GM_info.script.version;
    var _scriptVersionChanges = [
        GM_info.script.name + '\nv' + _scriptVersion + '\n\nWhat\'s New\n------------------------------',
        '\n- minor update.'
    ].join('');

    var _imagesPath = 'https://github.com/dalverson/wme-ohio-dot-reports/raw/master/images/';
    var _mapLayer = null;
    var _settings = {};
    var _reports = [];
    var _lastShownTooltipDiv;
    var _tableSortKeys = [];
    var _icon = {};
    var _columnSortOrder = ['properties.icon','properties.location_description','archived'];
    var _reportTitles = {RoadActivity: 'ROAD ACTIVITY', };

    function log(message, level) {
        if (message && level <= _debugLevel) {
            console.log('OH DOT Reports: ' + message);
        }
    }

    function saveSettingsToStorage() {
        if (localStorage) {
            var settings = {
                lastVersion: _scriptVersion,
                layerVisible: _mapLayer.visibility,
                state: _settings.state,
                hideArchivedReports: $('#hideOHDotArchivedReports').is(':checked'),
                archivedReports:_settings.archivedReports
            };
            localStorage.setItem(_settingsStoreName, JSON.stringify(settings));
            log('Settings saved', 1);
        }
    }

    function dynamicSort(property) {
        var sortOrder = 1;
        if(property[0] === "-") {
            sortOrder = -1;
            property = property.substr(1);
        }
        return function (a,b) {
            var props = property.split('.');
            props.forEach(function(prop) {
                a = a[prop];
                b = b[prop];
            });
            var result = (a < b) ? -1 : (a > b) ? 1 : 0;
            return result * sortOrder;
        };
    }

    function dynamicSortMultiple() {
        /*
     * save the arguments object as it will be overwritten
     * note that arguments object is an array-like object
     * consisting of the names of the properties to sort by
     */
        var props = arguments;
        if (arguments[0] && Array.isArray(arguments[0])) {
            props = arguments[0];
        }
        return function (obj1, obj2) {
            var i = 0, result = 0, numberOfProperties = props.length;
            /* try getting a different result from 0 (equal)
         * as long as we have extra properties to compare
         */
            while(result === 0 && i < numberOfProperties) {
                result = dynamicSort(props[i])(obj1, obj2);
                i++;
            }
            return result;
        };
    }

    function getReport(reportId) {
        for (var i=0; i<_reports.length; i++) {
            if (_reports[i].id === reportId) { return _reports[i]; }
        }
    }

    function isHideOptionChecked(reportType) {
        return $('#hideOHDot' + reportType + 'Reports').is(':checked');
    }

    function updateReportsVisibility() {
        hideAllReportPopovers();
        var hideArchived = isHideOptionChecked('Archived');
        var visibleCount = 0;
        _reports.forEach(function(report) {
            var hide =
                hideArchived && report.archived;
            if (hide) {
                report.dataRow.hide();
                if (report.imageDiv) { report.imageDiv.hide(); }
            } else {
                visibleCount += 1;
                report.dataRow.show();
                if (report.imageDiv) { report.imageDiv.show(); }
            }
        });
        $('.oh-dot-report-count').text(visibleCount + ' of ' + _reports.length + ' reports');
    }

    function hideAllPopovers($excludeDiv) {
        _reports.forEach(function(rpt) {
            var $div = rpt.imageDiv;
            if ((!$excludeDiv || $div[0] !== $excludeDiv[0]) && $div.data('state') === 'pinned') {
                $div.data('state', '');
                removePopup(rpt);
            }
        });
    }

    function deselectAllDataRows() {
        _reports.forEach(function(rpt) {
            rpt.dataRow.css('background-color','white');
        });
    }

    function toggleMarkerPopover($div) {
        hideAllPopovers($div);
        var id = $div.data('reportId');
        var report = getReport(id);
        if ($div.data('state') !== 'pinned') {
            $div.data('state', 'pinned');
            // W.map.setCenter(report.marker.lonlat);
            showPopup(report);
            if (report.archived) {
                $('.btn-archive-dot-report').text("Un-Archive");
            }
            $('.btn-archive-dot-report').click(function() {setArchiveReport(report,!report.archived, true); buildTable();});
            $('.btn-open-dot-report').click(function(evt) {evt.stopPropagation(); window.open($(this).data('dotReportUrl'),'_blank');});
            $('.reportPopover,.close-popover').click(function(evt) {evt.stopPropagation(); hideAllReportPopovers();});
            //$(".close-popover").click(function() {hideAllReportPopovers();});
            $div.data('report').dataRow.css('background-color','beige');
        } else {
            $div.data('state', '');
            removePopup(report);
        }
    }

    function toggleReportPopover($div) {
        deselectAllDataRows();
        toggleMarkerPopover($div);
    }

    function hideAllReportPopovers() {
        deselectAllDataRows();
        hideAllPopovers();
    }

    function setArchiveReport(report, archive, updateUi) {
        report.archived = archive;
        if (archive) {
            _settings.archivedReports[report.id] = {updateNumber: report.id};
            report.imageDiv.addClass('oh-dot-archived-marker');
        }else {
            delete _settings.archivedReports[report.id];
            report.imageDiv.removeClass('oh-dot-archived-marker');
        }
        if (updateUi) {
            saveSettingsToStorage();
            updateReportsVisibility();
            hideAllReportPopovers();
        }
    }

    function archiveAllReports(unarchive) {
        _reports.forEach(function(report) {
            setArchiveReport(report, !unarchive, false);
        });
        saveSettingsToStorage();
        buildTable();
        hideAllReportPopovers();
    }

    function addRow($table, report) {
        var $img = $('<img>', {src:report.imgUrl, class:'table-img'});
        var $row = $('<tr> class="clickable"', {id:'oh-dot-row-'+report.id}).append(
            $('<td>',{class:'centered'}).append(
                $('<input>',{type:'checkbox',title:'Archive',id:'oh-archive-' + report.id, 'data-report-id':report.id}).prop('checked', report.archived).click(
                    function(evt){
                        evt.stopPropagation();
                        var id = $(this).data('reportId');
                        var report = getReport(id);
                        setArchiveReport(report, $(this).is(':checked'), true);
                    }
                )
            ),
            $('<td>',{class:'clickable centered'}).append($img),
            $('<td>')
              .addClass(report.Status)
              .text(report.properties.location_description)
        )
        .click(function () {
            var $row = $(this);
            var id = $row.data('reportId');
            var marker = getReport(id).marker;
            var $imageDiv = report.imageDiv;
            //if (!marker.onScreen()) {
            W.map.setCenter(marker.lonlat);
            //}
            toggleReportPopover($imageDiv);

        }).data('reportId', report.id);
        report.dataRow = $row;
        $table.append($row);
        $row.report = report;
    }

    function onClickColumnHeader(obj) {
        var prop;
        switch (/oh-dot-table-(.*)-header/.exec(obj.id)[1]) {
            case 'category':
                prop = 'properties.icon';
                break;
            case 'begins':
                prop = 'beginTime.time';
                break;
            case 'desc':
                prop = 'properties.location_description';
                break;
            case 'priority':
                prop = 'priority';
                break;
            case 'archive':
                prop = 'archived';
                break;
            default:
                return;
        }
        var idx = _columnSortOrder.indexOf(prop);
        if (idx > -1) {
            _columnSortOrder.splice(idx, 1);
            _columnSortOrder.reverse();
            _columnSortOrder.push(prop);
            _columnSortOrder.reverse();
            buildTable();
        }
    }

    function buildTable() {
        log('Building table', 1);
        var $table = $('<table>',{class:'oh-dot-table'});
        var $th = $('<thead>').appendTo($table);
        $th.append(
            $('<tr>').append(
                $('<th>', {id:'oh-dot-table-archive-header',class:'centered'}).append(
                    $('<span>', {class:'fa fa-archive',style:'font-size:120%',title:'Sort by archived'}))).append(
                $('<th>', {id:'oh-dot-table-category-header',title:'Sort by report type'})).append(
                $('<th>',{id:'oh-dot-table-desc-header',title:'Sort by description'}).text('Description')
            ));
        _reports.sort(dynamicSortMultiple(_columnSortOrder));
        _reports.forEach(function(report) {
            addRow($table, report);
        });
        $('.oh-dot-table').remove();
        $('#oh-dot-report-table').append($table);
        $('.oh-dot-table th').click(function() {onClickColumnHeader(this);});

        updateReportsVisibility();
    }

    function checkURL(projURL) {
        var btnHtml = '';
        var pURL = '';
        var n = projURL.search('http');
        if (n >= 0) {
            pURL = projURL.substr(n);
        }
        else if (projURL.match(/ohio.gov|state.oh.us|www/)) {
            pURL = 'http://' + projURL;
            }

        if (pURL) {
            btnHtml = '<button type="button" class="btn btn-primary btn-open-dot-report" data-dot-report-url="' + pURL + '" style="float:left;">Open Link</button>';
        }
        return btnHtml;
    }

    function addReportToMap(report){
        var coord = report.coordinates;
        var imgName;
        var icon1 = _icon.roadwork;
        switch (report.Category) {
            case 'Crash':
                imgName = 'incident';
                icon1 = _icon.crash;
                if (report.Status == 'Closed') {
                    imgName = 'cl-incident';
                    icon1 = _icon.crash_closed;
                }
                break;
            case 'Flooding':
            case 'Snow/Ice':
                imgName = 'weather';
                icon1 = _icon.weather;
                break;
            case 'Roadwork - Planned':
            case 'Roadwork - Unplanned':
                imgName = 'construction';
                if (report.Status == 'Closed') {
                    imgName = 'closed';
                    icon1 = _icon.roadwork_closed;
                }
                break;
            default:
                imgName = 'incident';
                icon1 = _icon.crash;
                if (report.Status == 'Closed') {
                    imgName = 'cl-incident';
                    icon1 = _icon.crash_closed;
                }
        }
        report.properties.icon = icon1;
        imgName += '.png';
        var size = new OpenLayers.Size(29,29);
        var offset = new OpenLayers.Pixel(-(size.w/2), -size.h);
        var now = new Date(Date.now());

        report.imgUrl = _imagesPath + imgName;
        var icon = new OpenLayers.Icon(report.imgUrl,size,null);
        var marker = new OpenLayers.Marker(new OpenLayers.LonLat(coord[0],coord[1]).transform("EPSG:4326", "EPSG:900913"),icon);

        marker.report = report;
        _mapLayer.addMarker(marker);

        report.urlBtn = '';
        //if (report.Contact.ProjectURL) {
        //    report.urlBtn = checkURL( report.Contact.ProjectURL );
        //}
        var $imageDiv = $(marker.icon.imageDiv)
        .css('cursor', 'pointer')
        .addClass('ohDotReport')
        .on('click', function() {
            toggleReportPopover($(this));
        })
        .data('reportId', report.id)
        .data('state', '');

        $imageDiv.data('report', report);
        if (report.archived) { $imageDiv.addClass('oh-dot-archived-marker'); }
        report.imageDiv = $imageDiv;
        report.marker = marker;
    }

    function showPopup(rpt)
    {
        var popHtml = '<div id="ohPopup" class="reportPop popup" style="max-width:500px;width:500px;">' +
            '<div class="arrow"></div>' +
            '<div class="pop-title pop-title-' + rpt.Status + '" id="pop-drag">' + rpt.Category + '<div style="float:right;"><div class="close-popover">X</div></div></div>' +
            '<div class="pop-content">' +
            rpt.properties.location_description + '&nbsp;' + rpt.Direction + '<br><br>' +
            rpt.details + '</div>' +
            '<div><hr style="margin-bottom:5px;margin-top:5px;border-color:gainsboro"><div class="pop-btns" style="display:table;width:100%">' + rpt.urlBtn +
            '<button type="button" style="float:right;" class="btn btn-primary btn-archive-dot-report" data-dot-report-id="' + rpt.id + '">Archive</button></div></div>' +
            '</div>';
        $(".view-area.olMap").append(popHtml);
        var iconofs = rpt.imageDiv.offset();
        var center = $("#ohPopup").width()/2;
        var ofs = {};
        ofs.top = iconofs.top + 30;
        ofs.left = iconofs.left - center - $('#sidebarContent')[0].offsetWidth;
        $("#ohPopup").offset( ofs );
        $("#ohPopup").show();

        // Make the popup draggable
        dragElement(document.getElementById("ohPopup"));
        $(".close-popover").click(function() { toggleReportPopover(rpt.imageDiv); });
    }

    // dragElement from https://www.w3schools.com/howto/howto_js_draggable.asp
    function dragElement(elmnt) {
      var pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
      if (document.getElementById("pop-drag")) {
        // if present, the header is where you move the DIV from:
        document.getElementById("pop-drag").onmousedown = dragMouseDown;
      } else {
        // otherwise, move the DIV from anywhere inside the DIV:
        elmnt.onmousedown = dragMouseDown;
      }

      function dragMouseDown(e) {
        e = e || window.event;
        e.preventDefault();
        // get the mouse cursor position at startup:
        pos3 = e.clientX;
        pos4 = e.clientY;
        document.onmouseup = closeDragElement;
        // call a function whenever the cursor moves:
        document.onmousemove = elementDrag;
      }

      function elementDrag(e) {
        e = e || window.event;
        e.preventDefault();
        // calculate the new cursor position:
        pos1 = pos3 - e.clientX;
        pos2 = pos4 - e.clientY;
        pos3 = e.clientX;
        pos4 = e.clientY;
        // set the element's new position:
        elmnt.style.top = (elmnt.offsetTop - pos2) + "px";
        elmnt.style.left = (elmnt.offsetLeft - pos1) + "px";
      }

      function closeDragElement() {
        // stop moving when mouse button is released:
        document.onmouseup = null;
        document.onmousemove = null;
      }
    }
    function removePopup(rpt)
    {
        $("#ohPopup").remove();
        $("#ohPopup").hide();
    }

    function isArray(o)
    {
        return Object.prototype.toString.apply(o) === '[object Array]';
    }

    function processReportDetails(reportDetails, reports) {
        _reports = [];
        _mapLayer.clearMarkers();
        log('Adding reports to map...', 1);
        var top = reportDetails;

        for (var i = 0; i < top.length; i++) {
            var report = top[i];
            if (report.longitude) {
                report.coordinates = [ report.longitude, report.latitude ];
                report.properties = {};
                report.properties.icon = _icon.roadwork;
                report.Id = report.id; // legacy name
                report.dist = 'D??';
                if (report.district != null) {
                    if (report.district.length > 3) {
                        report.dist = 'D' + report.district.split(" ")[1];
                    } else {
                        report.dist = report.district;
                    }
                }
                report.county = "";
                report.Category = report.category;
                report.Direction = report.direction;
                if (report.roadStatus != null) {
                    report.Status = report.roadStatus;
                }
                else if (report.status != null) {
                    report.Status = report.status;
                }

                report.properties.location_description = [ report.dist + '-' + report.county, report.routeName, report.Status ].join(' ');
                report.details = '';

                //report.details = report.StartDate + ' - ' + report.EndDate + '<br>Location: ';
                if (report.startDate != null) {
                    report.details += report.startDate;
                    }
                if (report.endDate != null) {
                    report.details += " thru " + report.endDate;
                    }
                if (report.details.length > 2) {
                    report.details += '<br>';
                }

                /* if (report.StartMileDescription) {
                    report.details += report.StartMileDescription;
                    if (report.EndMileDescription && report.StartMileDescription != report.EndMileDescription) {
                        report.details += ' TO ' + report.EndMileDescription;
                    }
                } */
                /*if (report.StartMile) {
                    report.details += ' (MM: ' + report.StartMile + ' ';
                    if (report.EndMile && report.EndMile != report.StartMile) {
                        report.details += '- ' + report.EndMile + ' ';
                    }
                    report.details += ') ';
                } */

                report.details += report.description;
                // if (report.Contact.ProjectURL) { report.details += '<br>' + report.Contact.ProjectURL; }
                report.archived = false;
                if (_settings.archivedReports.hasOwnProperty(report.Id)) {
                    // if ( _settings.archivedReports[report.Id].updateNumber < report.situationUpdateKey.updateNumber) {
                    //     delete _settings.archivedReports[report.Id];
                    // } else {
                    report.archived = true;
                    // }
                }
                addReportToMap(report);
                _reports.push(report);
            }
        }
        buildTable();
    }

    function processReports(reports, context) {
        var x = reports.results;
        x.forEach(function(report) {
            report.type = context.type;
        });
        Array.prototype.push.apply(context.results.reports, x);

        if (context.results.callCount === context.results.expectedCallCount) {
            processReportDetails(context.results.reports);
        }
    }

    function requestReports(context) {
        GM_xmlhttpRequest({
            method: 'GET',
            context: context,
            url: 'https://publicapi.ohgo.com/api/v1/' + context.type + `?${DEC(TOKEN)}`,
            //onload: function(res) { res.context.results.callCount += 1; processReports($.parseJSON(/\((.*)\)/.exec(res.responseText)[1]).features, res.context); },
            onload: function(res) { res.context.results.callCount += 1; processReports($.parseJSON(res.responseText), res.context); },
            onError: function(err) { log(err,0); }
        });
    }

    function fetchReports() {
        var results = {callCount: 0, reports: [], expectedCallCount: 1};
        //var weatherClosureContext = { type:'weather_closure', results:results };
        var incidentContext= { type:'incidents', results:results };
        var constructionContext = { type:'construction', results:results };
        //var highImpactContext = { type: 'high_impact_incident', results: results};
        //var activityContext = { type: 'TrafficSpeedAndAlertMarkers', results: results};

        //requestReports(activityContext);
        //requestReports(weatherClosureContext);
        requestReports(incidentContext);
        requestReports(constructionContext);
        //requestReports(highImpactContext);
    }

    function onLayerVisibilityChanged(evt) {
        saveSettingsToStorage();
    }

    function installIcon() {
        OpenLayers.Icon = OpenLayers.Class({
            url: null,
            size: null,
            offset: null,
            calculateOffset: null,
            imageDiv: null,
            px: null,
            initialize: function(a,b,c,d){
                this.url=a;
                this.size=b||{w: 20,h: 20};
                this.offset=c||{x: -(this.size.w/2),y: -(this.size.h/2)};
                this.calculateOffset=d;
                a=OpenLayers.Util.createUniqueID("OL_Icon_");
                var div = this.imageDiv=OpenLayers.Util.createAlphaImageDiv(a);
                $(div.firstChild).removeClass('olAlphaImg');   // LEAVE THIS LINE TO PREVENT WME-HARDHATS SCRIPT FROM TURNING ALL ICONS INTO HARDHAT WAZERS --MAPOMATIC
            },
            destroy: function(){ this.erase();OpenLayers.Event.stopObservingElement(this.imageDiv.firstChild);this.imageDiv.innerHTML="";this.imageDiv=null; },
            clone: function(){ return new OpenLayers.Icon(this.url,this.size,this.offset,this.calculateOffset); },
            setSize: function(a){ null!==a&&(this.size=a); this.draw(); },
            setUrl: function(a){ null!==a&&(this.url=a); this.draw(); },
            draw: function(a){
                OpenLayers.Util.modifyAlphaImageDiv(this.imageDiv,null,null,this.size,this.url,"absolute");
                this.moveTo(a);
                return this.imageDiv;
            },
            erase: function(){ null!==this.imageDiv&&null!==this.imageDiv.parentNode&&OpenLayers.Element.remove(this.imageDiv); },
            setOpacity: function(a){ OpenLayers.Util.modifyAlphaImageDiv(this.imageDiv,null,null,null,null,null,null,null,a); },
            moveTo: function(a){
                null!==a&&(this.px=a);
                null!==this.imageDiv&&(null===this.px?this.display(!1): (
                    this.calculateOffset&&(this.offset=this.calculateOffset(this.size)),
                    OpenLayers.Util.modifyAlphaImageDiv(this.imageDiv,null,{x: this.px.x+this.offset.x,y: this.px.y+this.offset.y})
                ));
            },
            display: function(a){ this.imageDiv.style.display=a?"": "none"; },
            isDrawn: function(){ return this.imageDiv&&this.imageDiv.parentNode&&11!=this.imageDiv.parentNode.nodeType; },
            CLASS_NAME: "OpenLayers.Icon"
        });
    }

    function init511ReportsOverlay(){
        installIcon();
        _mapLayer = new OpenLayers.Layer.Markers("OH DOT Reports", {
            displayInLayerSwitcher: true,
            uniqueName: "__ohDotReports",
        });

        //I18n.translations[I18n.locale].layers.name.__stateDotReports = "OH DOT Reports";
        W.map.addLayer(_mapLayer);
        _mapLayer.setVisibility(true);
        // _mapLayer.events.register('visibilitychanged',null,onLayerVisibilityChanged);
    }

    async function initUserPanel() {
        var tabLabel;
        var tabPane;
        const pane = '<div class="side-panel-section>"><label style="width:100%; cursor:pointer; border-bottom: 1px solid #e0e0e0; margin-top:9px;" ' +
              'data-toggle="collapse" data-target="#ohDotSettingsCollapse" class="collapsed" aria-expanded="false">' +
              '<span class="fa fa-caret-down" style="margin-right:5px;font-size:120%;"></span>Hide reports...</label>' +
              '<div id="ohDotSettingsCollapse" class="collapse" aria-expanded="false" style="height: 0px;">' +
              '<div class="controls-container"><input type="checkbox" name="hideOHDotArchivedReports" id="hideOHDotArchivedReports">' +
              '<label for="hideOHDotArchivedReports">Archived</label></div></div></div>' +
              '<div class="side-panel-section>" id="oh-dot-report-table">' +
              '<div><span title="Click to refresh DOT reports" class="fa fa-refresh refreshIcon oh-dot-refresh-reports oh-dot-table-label" style="cursor:pointer;"></span>' +
              '<span class="oh-dot-table-label oh-dot-report-count count"></span>' +
              '<span id="archive-all" class="oh-dot-table-label oh-dot-table-action right">Archive all</span>' +
              '<span class="oh-dot-table-label right">|</span><span id="unarchive-all" class="oh-dot-table-label oh-dot-table-action right">Un-Archive all</span></div>';
             // '<table class="oh-dot-table"><thead><tr><th id="oh-dot-table-archive-header" class="centered"><span class="fa fa-archive" style="font-size:120%" title="Sort by archived"></span></th>' +
             // '<th id="oh-dot-table-category-header" title="Sort by report type"></th><th id="oh-dot-table-desc-header" title="Sort by description">Description</th></tr></thead>';

        var res = W.userscripts.registerSidebarTab("ohio-statedot");
        tabLabel = res.tabLabel;
        tabPane = res.tabPane;
        tabLabel.innerText = "OH DOT";
        tabLabel.title = "Ohio DOT Reports";
        tabPane.innerHTML = pane;
        await W.userscripts.waitForElementConnected(tabPane);
        $(tabLabel.parentElement).append(
                $('<span>', {title:'Click to refresh DOT reports', class:'fa fa-refresh refreshIcon nav-tab-icon oh-dot-refresh-reports', style:'cursor:pointer;'})
            );

        $("#archive-all").click(function() {
            var r = confirm('Are you sure you want to archive all reports for ' + _settings.state + '?');
            if (r===true) {
                archiveAllReports(false);
            }
        });
        $("#unarchive-all").click(function() {
            var r = confirm('Are you sure you want to un-archive all reports for ' + _settings.state + '?');
            if (r===true) {
                archiveAllReports(true);
            }
        });

        $('[id^=hideOHDot]').change(function(){
            saveSettingsToStorage();
            updateReportsVisibility();
        });
        $('.oh-dot-refresh-reports').click(function(e) {
            hideAllReportPopovers();
            fetchReports(processReports);
            var refreshPopup = $('#oh-dot-refresh-popup');
            refreshPopup.show();
            setTimeout(function() { refreshPopup.hide(); }, 1500);
            e.stopPropagation();
        });

        $('<div>', {id: 'oh-dot-refresh-popup',}).text('DOT Reports Refreshed').hide().appendTo($('div#editor-container'));

        (function setChecks(settingProps, checkboxIds) {
            for (var i=0; i<settingProps.length; i++) {
                if (_settings[settingProps[i]]) { $('#' + checkboxIds[i]).attr('checked', 'checked'); }
            }
        })(['hideArchivedReports'],
           ['hideOHDotArchivedReports']);
    }

    function showScriptInfoAlert() {
        /* Check version and alert on update */
        if (_alertUpdate && _scriptVersion !== _settings.lastVersion) {
            alert(_scriptVersionChanges);
        }
    }

    function initGui() {
        init511ReportsOverlay();
        initUserPanel();
        showScriptInfoAlert();
        fetchReports(processReports);

        var classHtml = [
            '.oh-dot-table th,td,tr {cursor:pointer;} ',
            '.oh-dot-table .centered {text-align:center;} ',
            '.oh-dot-table th:hover,tr:hover {background-color:aliceblue; outline: -webkit-focus-ring-color auto 5px;} ',
            '.oh-dot-table th:hover {color:blue; border-color:whitesmoke; } ',
            '.oh-dot-table {border:1px solid gray; border-collapse:collapse; width:100%; font-size:83%;margin:0px 0px 0px 0px} ',
            '.oh-dot-table th,td {border:1px solid gainsboro;} ',
            '.oh-dot-table td,th {color:black; padding:1px 4px;} ',
            '.oh-dot-table th {background-color:gainsboro;} ',
            '.oh-dot-table .table-img {max-width:24px; max-height:24px;} ',
            '.oh-dot-table .Closed {background-color:#ff9999;} ',
            '.oh-dot-table .Restricted {background-color:lightyellow;} ',
            '.tooltip.top > .tooltip-arrow {border-top-color:white;} ',
            '.tooltip.bottom > .tooltip-arrow {border-bottom-color:white;} ',
            '.reportPop {display: block; position: absolute; width: 500px;left: 30%;top: 35%;background: #fff;display: none;}',
            '.pop-title {background: #efefef;border: #ddd solid 1px;position: relative;display: block;}',
            '.pop-title-Closed {background: #ff9999;}',
            '.pop-title-Restricted {background-color:lightyellow;}',
            '.pop-content {display: block;font-family: sans-serif;padding: 5px 10px;}',
            '.pop-btns {padding: 5px 10px; }',
            '.close-popover {text-decoration:none;padding:0px 3px;cursor: pointer;border-width:1px;background-color:white;border-color:ghostwhite} .close-popover:hover {padding:0px 4px;border-style:outset;border-width:1px;background-color:white;border-color:ghostwhite;} ',
            '#oh-dot-refresh-popup {position:absolute;z-index:9999;top:80px;left:650px;background-color:rgb(120,176,191);e;font-size:120%;padding:3px 11px;box-shadow:6px 8px rgba(20,20,20,0.6);border-radius:5px;color:white;} ',
            '.refreshIcon:hover {color:blue; text-shadow: 2px 2px #aaa;} .refreshIcon:active{ text-shadow: 0px 0px; }',
            '.oh-dot-archived-marker {opacity:0.5;} ',
            '.oh-dot-table-label {font-size:85%;} .oh-dot-table-action:hover {color:blue;cursor:pointer} .oh-dot-table-label.right {float:right} .oh-dot-table-label.count {margin-left:4px;}'
        ].join('');
        $('<style type="text/css">' + classHtml + '</style>').appendTo('head');

        _previousZoom = W.map.zoom;
        W.map.events.register('moveend',null,function() {if (_previousZoom !== W.map.zoom) {hideAllReportPopovers();} _previousZoom=W.map.zoom;});
    }

    var _previousZoom;

    function checkZoom() {
        _mapLayer.setVisibility(W.map.getZoom() > 11);
    }

    function loadSettingsFromStorage() {
        var settings = $.parseJSON(localStorage.getItem(_settingsStoreName));
        if(!settings) {
            settings = {
                lastVersion:null,
                layerVisible:true,
                hideArchivedReports:true,
                archivedReports:{}
            };
        } else {
            settings.layerVisible = true; // (settings.layerVisible === true);
            if(typeof settings.hideArchivedReports === 'undefined') { settings.hideArchivedReports = true; }
            settings.archivedReports = settings.archivedReports ? settings.archivedReports : {};
        }
        _settings = settings;
    }

    function init() {
        _icon.weather = 1;
        _icon.crash = 4;
        _icon.crash_closed = 2;
        _icon.roadwork = 5;
        _icon.roadwork_closed = 3;
        loadSettingsFromStorage();
        initGui();
        _window.addEventListener('beforeunload', function saveOnClose() { saveSettingsToStorage(); }, false);
        W.map.events.register("zoomend", null, checkZoom);
        log('Initialized.', 0);
    }

    function bootstrap() {
        var wz = _window.W;
        if (wz && wz.loginManager &&
            wz.loginManager.events.register &&
            wz.map && wz.loginManager.user) {
            log('Initializing...', 1);
            init();
        } else {
            log('Bootstrap failed. Trying again...', 1);
            _window.setTimeout(function () {
                bootstrap();
            }, 1000);
        }
    }

    log('Bootstrap...', 0);
    bootstrap();
})();
